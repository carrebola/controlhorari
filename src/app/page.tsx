"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Activity, ArrowDownLeft, ArrowUpRight, Bell, CalendarClock, CheckCircle2, Clock3, House, Loader2, LogOut, RefreshCcw, Save, Settings, ShieldAlert, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MobileSwitch } from "@/components/ui/mobile-switch";
import { DailyPunches } from "@/components/daily-punches";
import { MobileSetup, removeDevicePush } from "@/components/mobile-setup";
import { dateKey, shiftLocalDate } from "@/lib/local-date";

type Role = "user" | "admin";
type Tab = "home" | "summary" | "notifications" | "settings" | "monitor";
type JobStatus = "scheduled" | "claimed" | "running" | "success" | "failed" | "uncertain" | "skipped" | "missed";
type Profile = { id: string; username: string; display_name: string; role: Role; enabled: number; margin_seconds: number; time_zone: string };
type Schedule = { weekday: number; enabled: number; entry_time: string; exit_time: string };
type Job = { id: string; local_date: string; action: "entry" | "exit"; target_at: number; planned_at: number | null; status: JobStatus; attempt_count: number; executed_at: number | null; timenet_time: string | null; error_message: string | null };
type PunchEvent = { id: string; local_date: string; action: "entry" | "exit"; source: "automatic" | "manual" | "unknown"; recorded_time: string; created_at: number };
type CalendarDay = { local_date: string; label: string; entry_time: string | null; exit_time: string | null; random_entry_at: number | null; random_exit_at: number | null; margin_seconds: number; synced_at: number };
type Notice = { id: string; level: "success" | "warning" | "error" | "info"; title: string; message: string; created_at: number; read_at: number | null };
type SchedulerRun = { id: string; started_at: number; finished_at: number | null; status: string; users_scanned: number; jobs_processed: number; success_count: number; failure_count: number; duration_ms: number | null };
type Dashboard = { ok: true; profile: Profile; schedules: Schedule[]; jobs: Job[]; events: PunchEvent[]; calendar: CalendarDay[]; notifications: Notice[]; health: { latestRun: SchedulerRun | null; schedulerHealthy: boolean; last24Hours: { success_count: number | null; failure_count: number | null; average_delay_ms: number | null } | null } };
type AdminHealth = { ok: true; latestRuns: SchedulerRun[]; statusCounts: { status: string; count: number }[]; users: { total: number; enabled: number }; recentFailures: Array<Job & { username: string; display_name: string }> };
type AdminUser = { id: string; username: string; display_name: string; role: Role; enabled: number; created_at: number };

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const dayNames = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const statusLabels: Record<JobStatus, string> = { scheduled: "Programado", claimed: "Preparando", running: "Ejecutando", success: "Correcto", failed: "Fallido", uncertain: "Revisar", skipped: "Omitido", missed: "No ejecutado" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) }, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.message || "No se pudo completar la petición.", response.status);
  return data as T;
}

function timeLabel(value: number | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Madrid" }).format(new Date(value));
}

function StatusBadge({ status }: { status: JobStatus }) {
  const palette = status === "success" ? "bg-emerald-100 text-emerald-800" : status === "failed" || status === "missed" ? "bg-red-100 text-red-800" : status === "uncertain" ? "bg-amber-100 text-amber-900" : status === "running" || status === "claimed" ? "bg-blue-100 text-blue-800" : "bg-zinc-100 text-zinc-700";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${palette}`}>{statusLabels[status]}</span>;
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"><p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>{detail && <p className="mt-1 text-sm text-zinc-600">{detail}</p>}</div>;
}

export default function Home() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [adminHealth, setAdminHealth] = useState<AdminHealth | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshingToday, setRefreshingToday] = useState(false);
  const [todayFresh, setTodayFresh] = useState(false);
  const todayRequest = useRef<Promise<void> | null>(null);
  const historyLoaded = useRef(false);
  const sessionGeneration = useRef(0);
  const lastTimenetSyncAt = useRef(0);
  const todayFreshRef = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<Tab>("home");
  const [punching, setPunching] = useState<"entry" | "exit" | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [viewDate, setViewDate] = useState<string | null>(null);
  const daySwipeCleanup = useRef<(() => void) | null>(null);
  const browseHomeDayRef = useRef<(delta: -1 | 1, commit?: boolean) => Promise<boolean>>(async () => false);
  const commitHomeDayRef = useRef<(delta: -1 | 1) => void>(() => {});
  const dashboardRef = useRef<Dashboard | null>(null);
  const viewDateRef = useRef<string | null>(null);
  dashboardRef.current = dashboard;
  viewDateRef.current = viewDate;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [margin, setMargin] = useState(60);
  const [newPin, setNewPin] = useState("");
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [userForm, setUserForm] = useState({ username: "", displayName: "", password: "", timenetPin: "", role: "user" as Role });

  const applyDashboard = useCallback((data: Dashboard) => {
    setDashboard(data); setEnabled(Boolean(data.profile.enabled)); setMargin(data.profile.margin_seconds); setSchedules(data.schedules);
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try { applyDashboard(await api<Dashboard>("/me")); }
    catch (cause) { setDashboard(null); if (cause instanceof Error && !/Sesión no válida/.test(cause.message)) setError(cause.message); }
    finally { setLoading(false); }
  }, [applyDashboard]);

  const refreshToday = useCallback((initial = false, full = false): Promise<void> => {
    if (todayRequest.current) return todayRequest.current;
    const generation = sessionGeneration.current;
    const current = () => sessionGeneration.current === generation;
    // Only lock punches on login/manual sync. Background resumes must not clear
    // todayFresh: a failed Timenet check would leave Entrada/Salida as "No disponible".
    const lockPunches = initial || full;
    const request = (async () => {
      setRefreshingToday(true);
      if (lockPunches) {
        todayFreshRef.current = false;
        setTodayFresh(false);
      }
      setError("");
      let saved: Dashboard | null = null;
      try {
        // Paint the small saved snapshot immediately, with manual actions locked
        // until the remote check completes. History is loaded only on demand.
        if (initial) {
          saved = await api<Dashboard>("/me/today");
          if (!current()) return;
          applyDashboard(saved); setLoading(false);
        }
        let latest: Dashboard;
        if (full) {
          await api("/me/history/sync", { method: "POST", body: "{}" });
          latest = await api<Dashboard>("/me");
          historyLoaded.current = true;
        } else latest = await api<Dashboard>("/me/today/sync", { method: "POST", body: "{}" });
        if (!current()) return;
        setDashboard((previous) => {
          if (!previous || full) return latest;
          const date = new Intl.DateTimeFormat("en-GB", { timeZone: latest.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
          return { ...latest,
            calendar: [...previous.calendar.filter((row) => row.local_date !== date), ...latest.calendar],
            events: [...previous.events.filter((row) => row.local_date !== date), ...latest.events],
            jobs: [...previous.jobs.filter((row) => row.local_date !== date), ...latest.jobs] };
        });
        setEnabled(Boolean(latest.profile.enabled));
        if (initial) {
          setMargin(latest.profile.margin_seconds);
          setSchedules(latest.schedules);
        }
        todayFreshRef.current = true;
        setTodayFresh(true); setNeedsReview(false);
        lastTimenetSyncAt.current = Date.now();
      } catch (cause) {
        if (!current()) return;
        if (cause instanceof ApiError && cause.status === 401) { setDashboard(null); return; }
        if (initial && saved) applyDashboard(saved);
        if (!lockPunches && todayFreshRef.current) {
          setError(`No se pudo refrescar Timenet. Se mantienen los últimos datos confirmados. ${cause instanceof Error ? cause.message : ""}`.trim());
        } else {
          setError(`No se pudo actualizar el estado de hoy. ${saved ? "Se muestran los últimos datos guardados. " : ""}${cause instanceof Error ? cause.message : "Vuelve a sincronizar."}`);
        }
      } finally {
        if (current()) { setRefreshingToday(false); setLoading(false); }
      }
    })();
    todayRequest.current = request;
    void request.finally(() => { if (todayRequest.current === request) todayRequest.current = null; });
    return request;
  }, [applyDashboard]);

  const mergeHistoryPreservingToday = useCallback((data: Dashboard, previous: Dashboard | null) => {
    if (!previous) return data;
    const date = new Intl.DateTimeFormat("en-GB", { timeZone: previous.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    return {
      ...previous,
      calendar: [...data.calendar.filter((row) => row.local_date !== date), ...previous.calendar.filter((row) => row.local_date === date)],
      events: [...data.events.filter((row) => row.local_date !== date), ...previous.events.filter((row) => row.local_date === date)],
      jobs: [...data.jobs.filter((row) => row.local_date !== date), ...previous.jobs.filter((row) => row.local_date === date)],
    };
  }, []);

  const ensureHistoryLoaded = useCallback(async () => {
    if (historyLoaded.current) return dashboardRef.current;
    const data = await api<Dashboard>("/me");
    historyLoaded.current = true;
    const merged = mergeHistoryPreservingToday(data, dashboardRef.current);
    dashboardRef.current = merged;
    setDashboard(merged);
    return merged;
  }, [mergeHistoryPreservingToday]);

  const browseHomeDay = useCallback(async (delta: -1 | 1, commit = true) => {
    let snapshot: Dashboard | null;
    try {
      snapshot = await ensureHistoryLoaded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el histórico.");
      return false;
    }
    snapshot = snapshot ?? dashboardRef.current;
    if (!snapshot) return false;
    const todayDate = new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    const current = viewDateRef.current ?? todayDate;
    const next = shiftLocalDate(current, delta);
    const bounds = [...snapshot.calendar.map((day) => day.local_date), todayDate]
      .map(dateKey)
      .sort((a, b) => a.localeCompare(b));
    if (!bounds.length) return false;
    const key = dateKey(next);
    if (key < bounds[0] || key > bounds[bounds.length - 1]) return false;
    if (commit) setViewDate(next === todayDate ? null : next);
    return true;
  }, [ensureHistoryLoaded]);
  browseHomeDayRef.current = browseHomeDay;
  commitHomeDayRef.current = (delta) => {
    const snapshot = dashboardRef.current;
    if (!snapshot) return;
    const todayDate = new Intl.DateTimeFormat("en-GB", { timeZone: snapshot.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    const current = viewDateRef.current ?? todayDate;
    const next = shiftLocalDate(current, delta);
    setViewDate(next === todayDate ? null : next);
  };

  const bindDaySwipe = useCallback((node: HTMLDivElement | null) => {
    daySwipeCleanup.current?.();
    daySwipeCleanup.current = null;
    if (!node) return;
    const track = node.querySelector<HTMLElement>("[data-day-track]");
    if (!track) return;

    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let axis: "h" | "v" | null = null;
    let active = false;
    let pointerId: number | null = null;
    let busySlide = false;
    let slideTimer = 0;
    // Pixel + rAF: globals reduced-motion forces transition-duration: 0.01ms !important,
    // so CSS transitions cannot settle slowly. Drive the ease in JS instead.
    const panelWidth = () => Math.max(node.clientWidth, 1);
    const baseX = () => -panelWidth();
    const paintX = (x: number) => {
      track.style.transition = "none";
      track.style.transform = `translate3d(${x}px, 0, 0)`;
    };
    const slideMs = 420;
    let slideRaf = 0;

    const animateTo = (x: number) => {
      window.clearTimeout(slideTimer);
      if (slideRaf) cancelAnimationFrame(slideRaf);
      const start = new DOMMatrix(getComputedStyle(track).transform).m41 || baseX();
      const delta = x - start;
      if (Math.abs(delta) < 0.5) {
        paintX(x);
        return Promise.resolve();
      }
      const startedAt = performance.now();
      const ease = (t: number) => 1 - ((1 - t) ** 3);
      return new Promise<void>((resolve) => {
        let done = false;
        const complete = () => {
          if (done) return;
          done = true;
          window.clearTimeout(slideTimer);
          if (slideRaf) cancelAnimationFrame(slideRaf);
          slideRaf = 0;
          paintX(x);
          resolve();
        };
        const tick = (now: number) => {
          const t = Math.min(1, (now - startedAt) / slideMs);
          paintX(start + delta * ease(t));
          if (t < 1) {
            slideRaf = requestAnimationFrame(tick);
            return;
          }
          complete();
        };
        slideRaf = requestAnimationFrame(tick);
        slideTimer = window.setTimeout(complete, slideMs + 120);
      });
    };

    const resetGesture = () => { active = false; axis = null; pointerId = null; };

    const finish = (dx: number, usedAxis: "h" | "v" | null) => {
      if (busySlide) return;
      busySlide = true;
      const width = panelWidth();
      const origin = baseX();
      if (usedAxis !== "h" || Math.abs(dx) < Math.min(40, width * 0.12)) {
        void (async () => {
          await animateTo(origin);
          busySlide = false;
        })();
        return;
      }
      const outbound = dx < 0 ? origin - width : origin + width;
      const direction: -1 | 1 = dx < 0 ? 1 : -1;
      void (async () => {
        const pending = browseHomeDayRef.current(direction, false);
        await animateTo(outbound);
        const allowed = await pending;
        if (allowed) {
          // Commit date and reset track in the same paint to avoid flashing the previous card.
          flushSync(() => { commitHomeDayRef.current(direction); });
          paintX(origin);
        } else {
          await animateTo(origin);
        }
        busySlide = false;
      })();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (busySlide) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      active = true;
      axis = null;
      pointerId = event.pointerId;
      startX = event.clientX;
      lastX = event.clientX;
      startY = event.clientY;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!active || pointerId !== event.pointerId) return;
      lastX = event.clientX;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (axis === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
        if (axis === "h") {
          try { node.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        }
      }
      if (axis === "h") {
        event.preventDefault();
        track.style.transition = "none";
        paintX(baseX() + dx);
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const dx = (event.clientX || lastX) - startX;
      const usedAxis = axis;
      const captured = pointerId;
      // Finish before releaseCapture so cancel cannot reverse the settle animation.
      finish(dx, usedAxis);
      resetGesture();
      if (captured != null && node.hasPointerCapture(captured)) {
        try { node.releasePointerCapture(captured); } catch { /* ignore */ }
      }
    };
    const onCancel = () => {
      if (busySlide) {
        resetGesture();
        return;
      }
      resetGesture();
      busySlide = true;
      void (async () => {
        await animateTo(baseX());
        busySlide = false;
      })();
    };

    track.style.transition = "none";
    paintX(baseX());
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerUp);
    node.addEventListener("pointercancel", onCancel);
    daySwipeCleanup.current = () => {
      window.clearTimeout(slideTimer);
      if (slideRaf) cancelAnimationFrame(slideRaf);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onCancel);
      track.style.transition = "none";
      paintX(baseX());
    };
  }, []);

  useEffect(() => () => { daySwipeCleanup.current?.(); daySwipeCleanup.current = null; }, []);

  useEffect(() => {
    if ((tab !== "summary" && tab !== "home") || !dashboard?.profile.id || historyLoaded.current) return;
    let cancelled = false;
    const generation = sessionGeneration.current;
    void api<Dashboard>("/me").then((data) => {
      if (cancelled || generation !== sessionGeneration.current) return;
      historyLoaded.current = true;
      setDashboard((previous) => {
        const merged = mergeHistoryPreservingToday(data, previous);
        dashboardRef.current = merged;
        return merged;
      });
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudo cargar el histórico."); });
    return () => { cancelled = true; };
  }, [tab, dashboard?.profile.id, mergeHistoryPreservingToday]);

  useEffect(() => {
    if (tab !== "home") setViewDate(null);
  }, [tab]);

  useEffect(() => {
    void refreshToday(true).then(() => { if (new URLSearchParams(window.location.search).get("view") === "notifications") setTab("notifications"); });
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  }, [refreshToday]);
  useEffect(() => {
    if (!dashboard?.profile.id) return;
    const resume = () => {
      if (document.visibilityState !== "visible" || busy) return;
      // Background resume uses the local cache only. Timenet is hit on login and via the sync button.
      void api<Dashboard>("/me/today").then((data) => {
        setDashboard((previous) => {
          if (!previous) return data;
          const date = new Intl.DateTimeFormat("en-GB", { timeZone: data.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
          return { ...data,
            calendar: [...previous.calendar.filter((row) => row.local_date !== date), ...data.calendar],
            events: [...previous.events.filter((row) => row.local_date !== date), ...data.events],
            jobs: [...previous.jobs.filter((row) => row.local_date !== date), ...data.jobs] };
        });
        setEnabled(Boolean(data.profile.enabled));
      }).catch(() => { /* Keep the last good snapshot while offline. */ });
    };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) resume(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", restored);
    window.addEventListener("online", resume);
    return () => { document.removeEventListener("visibilitychange", resume); window.removeEventListener("pageshow", restored); window.removeEventListener("online", resume); };
  }, [dashboard?.profile.id, busy]);
  useEffect(() => {
    if (tab !== "monitor" || dashboard?.profile.role !== "admin") return;
    void Promise.all([api<AdminHealth>("/admin/health"), api<{ ok: true; users: AdminUser[] }>("/admin/users")])
      .then(([health, users]) => { setAdminHealth(health); setAdminUsers(users.users); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "No se pudo cargar el monitor."));
  }, [tab, dashboard?.profile.role]);

  const nextJob = dashboard?.jobs.filter((job) => ["scheduled", "claimed", "running"].includes(job.status)).sort((a, b) => a.target_at - b.target_at)[0];
  const unread = dashboard?.notifications.filter((notice) => !notice.read_at).length ?? 0;

  async function signIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); setPassword(""); await refreshToday(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo iniciar sesión."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    historyLoaded.current = false;
    setViewDate(null);
    sessionGeneration.current++; todayRequest.current = null; lastTimenetSyncAt.current = 0;
    todayFreshRef.current = false; setRefreshingToday(false); setTodayFresh(false);
    await removeDevicePush().catch(() => { /* Logout still clears the session if the device is offline. */ });
    setBusy(true); try { await api("/auth/logout", { method: "POST", body: "{}" }); } catch { /* The proxy still clears the local cookie. */ }
    setDashboard(null); setBusy(false); setTab("home"); setNeedsReview(false);
  }

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      if (schedules.length !== 7) throw new Error("El horario semanal aún no está cargado. Espera un momento y vuelve a guardar.");
      await api("/me/config", { method: "PUT", body: JSON.stringify({ enabled, marginSeconds: margin, timenetPin: newPin || undefined, schedules: schedules.map((day) => ({ enabled: Boolean(day.enabled), entry: day.entry_time, exit: day.exit_time })) }) });
      setNewPin(""); setMessage("Configuración guardada en el servidor."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo guardar la configuración."); }
    finally { setBusy(false); }
  }

  async function toggleAutomation() {
    if (!dashboard || busy) return;
    const next = !Boolean(dashboard.profile.enabled);
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/me/config", { method: "PUT", body: JSON.stringify({
        enabled: next,
        marginSeconds: dashboard.profile.margin_seconds,
        schedules: dashboard.schedules.map((day) => ({ enabled: Boolean(day.enabled), entry: day.entry_time, exit: day.exit_time })),
      }) });
      setEnabled(next);
      setDashboard((current) => current ? { ...current, profile: { ...current.profile, enabled: next ? 1 : 0 } } : current);
      await api<Dashboard>("/me").then(setDashboard).catch(() => { /* Keep the saved state if the refresh is temporarily unavailable. */ });
      setMessage(next ? "Fichaje automático activado." : "Fichaje automático pausado.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo cambiar la automatización.");
    } finally { setBusy(false); }
  }

  async function markNotificationsRead() { await api("/me/notifications/read", { method: "POST", body: "{}" }); await refresh(); }

  async function syncHistory() {
    setMessage(""); await refreshToday(false, true);
  }

  async function manualPunch(action: "entry" | "exit") {
    if (busy || needsReview || !todayFresh) return;
    setBusy(true); setPunching(action); setError(""); setMessage("");
    try {
      const result = await api<{ ok: boolean; uncertain?: boolean; message: string }>("/me/punch", { method: "POST", body: JSON.stringify({ action, requestId: crypto.randomUUID() }) });
      if (result.uncertain) setNeedsReview(true);
      if (!result.ok) setError(result.message); else setMessage(result.message);
      setDashboard(await api<Dashboard>("/me"));
    } catch (cause) {
      setNeedsReview(true);
      setError(`${cause instanceof Error ? cause.message : "No se pudo confirmar el fichaje."} Sincroniza Timenet antes de repetir.`);
    } finally { setBusy(false); setPunching(null); }
  }

  async function createAccount(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      await api("/admin/users", { method: "POST", body: JSON.stringify(userForm) });
      setUserForm({ username: "", displayName: "", password: "", timenetPin: "", role: "user" });
      const users = await api<{ ok: true; users: AdminUser[] }>("/admin/users");
      setAdminUsers(users.users); setMessage("Usuario creado. Ya puede iniciar sesión y configurar su horario.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo crear el usuario."); }
    finally { setBusy(false); }
  }

  if (loading) return <main className="grid min-h-dvh place-items-center bg-zinc-50"><p role="status" className="text-sm text-zinc-600">Actualizando el estado de hoy…</p></main>;

  if (!dashboard) return <main className="min-h-dvh bg-zinc-50 px-4 py-10 text-zinc-950"><div className="mx-auto max-w-sm"><div className="mb-8 flex items-center gap-3"><div className="rounded-2xl bg-emerald-700 p-3 text-white"><Clock3 className="h-7 w-7" /></div><div><p className="text-sm text-zinc-500">FP Llefià · Timenet</p><h1 className="text-2xl font-semibold">Control Horari</h1></div></div><section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold">Acceder</h2><p className="mt-1 text-sm text-zinc-500">Consulta tus fichajes y controla la automatización.</p><form className="mt-6 space-y-4" onSubmit={signIn}><div><Label htmlFor="username">Usuario</Label><Input id="username" autoComplete="username" className="mt-1 h-12" required value={username} onChange={(event) => setUsername(event.target.value)} /></div><div><Label htmlFor="password">Contraseña</Label><Input id="password" type="password" autoComplete="current-password" className="mt-1 h-12" required value={password} onChange={(event) => setPassword(event.target.value)} /></div><Button className="h-12 w-full" disabled={busy}>{busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Accediendo…</> : "Entrar"}</Button></form>{error && <p role="alert" className="mx-4 mt-2 shrink-0 rounded-2xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}</section></div></main>;

  const tabs: Array<[Tab, LucideIcon, string]> = [["home", House, "Inicio"], ["summary", CalendarClock, "Fichajes"], ["notifications", Bell, "Avisos"], ["settings", Settings, "Ajustes"]];
  if (dashboard.profile.role === "admin") tabs.push(["monitor", Activity, "Monitor"]);
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: dashboard.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
  const homeDate = viewDate ?? today;
  const homePrevDate = shiftLocalDate(homeDate, -1);
  const homeNextDate = shiftLocalDate(homeDate, 1);
  const viewingToday = homeDate === today;
  const entryRecorded = dashboard.events.some((event) => event.local_date === today && event.action === "entry");
  const exitRecorded = dashboard.events.some((event) => event.local_date === today && event.action === "exit");
  return <main className="app-viewport text-zinc-950"><div className="app-shell">
    <header className="app-header">
      <div className="header-brand flex min-w-0 items-center gap-2"><Image src="/icon-192.png" alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-xl" /><div className="min-w-0"><p className="truncate text-xs font-medium text-zinc-600">{dashboard.profile.display_name}</p><h1 className="whitespace-nowrap text-xl font-bold tracking-tight">Mi jornada<span className="text-emerald-600">.</span></h1></div></div>
      <div className="flex shrink-0 items-center gap-2">
        <MobileSwitch compact label="Fichaje automático" checked={Boolean(dashboard.profile.enabled)} disabled={busy} onChange={() => void toggleAutomation()} />
        <Button className="h-12 w-12 rounded-2xl bg-zinc-50" variant="ghost" size="icon" title={refreshingToday ? "Actualizando Timenet…" : "Sincronizar Timenet"} aria-label={refreshingToday ? "Actualizando Timenet…" : "Sincronizar Timenet"} aria-busy={refreshingToday || undefined} disabled={busy || refreshingToday} onClick={() => void syncHistory()}>{refreshingToday ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <RefreshCcw className={`h-5 w-5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />}</Button>
        <Button className="h-12 w-12 rounded-2xl" variant="ghost" size="icon" title="Cerrar sesión" aria-label="Cerrar sesión" onClick={() => void signOut()} disabled={busy}><LogOut className="h-4 w-4" /></Button>
      </div>
    </header>
    {error && <p role="alert" className="mx-4 mt-2 shrink-0 rounded-2xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}{message && <p role="status" className="mx-4 mt-2 shrink-0 rounded-2xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}

    <div className={`app-content min-h-0 flex-1 px-4 ${tab === "summary" || tab === "home" ? "flex flex-col overflow-hidden" : "overflow-y-auto overscroll-contain"}`}>
    {tab === "home" && <section className="relative flex min-h-0 flex-1 flex-col gap-3 pt-4 pb-3">
      {refreshingToday && <p role="status" className="pointer-events-none absolute inset-x-0 top-1 z-10 mx-auto flex w-fit items-center justify-center gap-2 rounded-full bg-zinc-50/95 px-3 py-1 text-sm text-zinc-600 shadow-sm ring-1 ring-zinc-200/80 backdrop-blur-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Actualizando desde Timenet…</p>}
      {!refreshingToday && !todayFresh && <p role="status" className="pointer-events-none absolute inset-x-0 top-1 z-10 mx-auto w-fit rounded-full bg-amber-50/95 px-3 py-1 text-sm text-zinc-600 shadow-sm ring-1 ring-amber-200/80 backdrop-blur-sm">Estado sin actualizar · sincroniza para continuar</p>}
      <div
        ref={bindDaySwipe}
        className="day-swipe min-h-0 flex-1 overflow-hidden overscroll-contain rounded-xl"
        aria-label={`Jornada del ${homeDate}. Desliza horizontalmente para cambiar de día.`}
      >
        <div data-day-track className="day-swipe-track flex h-full w-[300%] touch-pan-y will-change-transform">
          <div className="day-swipe-panel box-border h-full w-1/3 shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5">
            <DailyPunches calendar={dashboard.calendar ?? []} events={dashboard.events} jobs={dashboard.jobs} timeZone={dashboard.profile.time_zone} enabled={Boolean(dashboard.profile.enabled)} todayOnly selectedDate={homePrevDate} />
          </div>
          <div className="day-swipe-panel box-border h-full w-1/3 shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5">
            <DailyPunches calendar={dashboard.calendar ?? []} events={dashboard.events} jobs={dashboard.jobs} timeZone={dashboard.profile.time_zone} enabled={Boolean(dashboard.profile.enabled)} todayOnly selectedDate={homeDate} />
          </div>
          <div className="day-swipe-panel box-border h-full w-1/3 shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5">
            <DailyPunches calendar={dashboard.calendar ?? []} events={dashboard.events} jobs={dashboard.jobs} timeZone={dashboard.profile.time_zone} enabled={Boolean(dashboard.profile.enabled)} todayOnly selectedDate={homeNextDate} />
          </div>
        </div>
      </div>
      <div className="home-day-actions shrink-0">
        {viewingToday ? <>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" aria-label={punching === "entry" ? "Fichando…" : refreshingToday ? "Actualizando…" : entryRecorded ? "Entrada registrada" : "Fichar entrada"} aria-busy={punching === "entry" || refreshingToday || undefined} disabled={busy || refreshingToday || !todayFresh || needsReview || entryRecorded} onClick={() => void manualPunch("entry")} className="punch-action flex h-24 touch-manipulation flex-col items-center justify-center gap-1 rounded-3xl bg-emerald-800 px-3 py-3 text-white shadow-sm transition-colors active:bg-emerald-900 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300"><span aria-hidden="true" className="grid h-7 w-7 place-items-center">{punching === "entry" || (refreshingToday && !entryRecorded) ? <Loader2 className="h-7 w-7 animate-spin" /> : entryRecorded ? <CheckCircle2 className="h-7 w-7" /> : !todayFresh || needsReview || busy ? <ShieldAlert className="h-7 w-7" /> : <ArrowDownLeft className="h-7 w-7" />}</span><span className="text-base font-semibold leading-tight">{punching === "entry" ? "Fichando…" : refreshingToday && !entryRecorded ? "Actualizando…" : entryRecorded ? "Entrada registrada" : "Fichar entrada"}</span><span className="text-xs font-medium leading-none">{entryRecorded ? "Completado" : punching === "entry" || refreshingToday ? "Espera" : !todayFresh || needsReview || busy ? "No disponible" : "Disponible"}</span></button>
          <button type="button" aria-label={punching === "exit" ? "Fichando…" : refreshingToday ? "Actualizando…" : exitRecorded ? "Salida registrada" : "Fichar salida"} aria-busy={punching === "exit" || refreshingToday || undefined} disabled={busy || refreshingToday || !todayFresh || needsReview || exitRecorded} onClick={() => void manualPunch("exit")} className="punch-action flex h-24 touch-manipulation flex-col items-center justify-center gap-1 rounded-3xl bg-rose-700 px-3 py-3 text-white shadow-sm transition-colors active:bg-rose-800 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-300"><span aria-hidden="true" className="grid h-7 w-7 place-items-center">{punching === "exit" || (refreshingToday && !exitRecorded) ? <Loader2 className="h-7 w-7 animate-spin" /> : exitRecorded ? <CheckCircle2 className="h-7 w-7" /> : !todayFresh || needsReview || busy ? <ShieldAlert className="h-7 w-7" /> : <ArrowUpRight className="h-7 w-7" />}</span><span className="text-base font-semibold leading-tight">{punching === "exit" ? "Fichando…" : refreshingToday && !exitRecorded ? "Actualizando…" : exitRecorded ? "Salida registrada" : "Fichar salida"}</span><span className="text-xs font-medium leading-none">{exitRecorded ? "Completado" : punching === "exit" || refreshingToday ? "Espera" : !todayFresh || needsReview || busy ? "No disponible" : "Disponible"}</span></button>
        </div>
        <p className="mt-2 text-center text-xs text-zinc-600">{needsReview ? "Sincroniza para revisar el último fichaje antes de continuar." : refreshingToday ? "Consultando Timenet…" : "Fichaje manual en Timenet · se registra al pulsar"}</p>
        </> : <div className="home-day-actions-alt flex h-full flex-col items-center justify-center rounded-2xl border border-zinc-200 bg-white px-4 text-center">
          <p className="text-sm text-zinc-600">Consultando otro día. El fichaje manual solo está disponible hoy.</p>
          <Button className="mt-3" variant="secondary" onClick={() => setViewDate(null)}>Volver a hoy</Button>
        </div>}
      </div>
    </section>}
    {tab === "summary" && <section className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
      {nextJob && <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2"><div className="text-xs"><span className="text-zinc-500">Próximo · </span><span className="font-medium">{nextJob.action === "entry" ? "Entrada" : "Salida"}</span><span className="ml-2 text-zinc-500">{timeLabel(nextJob.target_at)}</span></div><StatusBadge status={nextJob.status} /></div>}
      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 pb-2 text-xl font-bold tracking-tight">Fichajes de Timenet</h2>
        <div data-punch-scroll role="region" aria-label="Fichajes de Timenet" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl pb-4">
          <DailyPunches calendar={dashboard.calendar ?? []} events={dashboard.events} jobs={dashboard.jobs} timeZone={dashboard.profile.time_zone} enabled={Boolean(dashboard.profile.enabled)} />
        </div>
      </div>
    </section>}

    {tab === "notifications" && <section className="py-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Avisos</h2><p className="text-sm text-zinc-500">Resultados y problemas de los fichajes.</p></div>{unread > 0 && <Button variant="secondary" onClick={() => void markNotificationsRead()}>Marcar leídos</Button>}</div><div className="space-y-3">{dashboard.notifications.map((notice) => <article key={notice.id} className={`rounded-xl border p-4 ${notice.level === "error" ? "border-rose-200 bg-rose-50/60" : notice.level === "warning" ? "border-amber-200 bg-amber-50/60" : notice.level === "success" ? "border-emerald-200 bg-emerald-50/60" : "border-zinc-200 bg-white"}`}><div className="flex gap-3">{notice.level === "success" ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : notice.level === "error" ? <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" /> : <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}<div><p className="font-medium">{notice.title}</p><p className="mt-1 text-sm text-zinc-600">{notice.message}</p><p className="mt-2 text-xs text-zinc-400">{timeLabel(notice.created_at)}</p></div></div></article>)}{!dashboard.notifications.length && <p className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-500">No hay avisos.</p>}</div></section>}

    <MobileSetup visible={tab === "settings"} />
    {tab === "settings" && <section className="py-5"><div className="mb-5"><h2 className="text-lg font-semibold">Configuración</h2><p className="text-sm text-zinc-500">Los cambios se guardan en el servidor. Al guardar el margen o el horario se recalcula el aleatorio de los días futuros aún sin fichar (entrada 10 min antes y salida 10 min después del previsto de Timenet); los días ya fichados se conservan.</p></div><form className="space-y-4 pb-4" onSubmit={saveConfiguration}><div className="rounded-xl border border-zinc-200 bg-white p-4"><Label htmlFor="margin">Margen aleatorio (± segundos)</Label><p className="mt-1 text-sm text-zinc-500">Se aplica al crear o recalcular el plan de días sin fichar.</p><Input id="margin" className="mt-2 h-11" type="number" inputMode="numeric" min={0} max={3600} value={margin} onChange={(event) => setMargin(Number(event.target.value))} /></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><Label htmlFor="new-pin">Cambiar PIN de Timenet</Label><Input id="new-pin" className="mt-2 h-11" type="password" inputMode="numeric" autoComplete="off" placeholder="Déjalo vacío para conservarlo" value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ""))} /></div><div className="space-y-3"><h3 className="font-semibold">Días con automatización</h3><p className="text-sm text-zinc-500">Activa o pausa cada día. Las horas de reserva solo se usan si aún no hay previsto de Timenet.</p>{schedules.map((day, index) => <div key={day.weekday} className="rounded-xl border border-zinc-200 bg-white p-4"><MobileSwitch label={`Automatizar ${dayNames[day.weekday]}`} checked={Boolean(day.enabled)} onChange={() => setSchedules(schedules.map((value, position) => position === index ? { ...value, enabled: value.enabled ? 0 : 1 } : value))}><span className="block text-base font-semibold">{dayNames[day.weekday]}</span><span className="block text-sm text-zinc-500">{day.enabled ? "Fichaje automático" : "Sin automatización"}</span></MobileSwitch><div hidden={!day.enabled} className="mt-3 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-3"><div><Label htmlFor={`entry-${day.weekday}`}>Entrada (reserva)</Label><Input id={`entry-${day.weekday}`} className="mt-1 h-11" type="time" disabled={!day.enabled} value={day.entry_time} onChange={(event) => setSchedules(schedules.map((value, position) => position === index ? { ...value, entry_time: event.target.value } : value))} /></div><div><Label htmlFor={`exit-${day.weekday}`}>Salida (reserva)</Label><Input id={`exit-${day.weekday}`} className="mt-1 h-11" type="time" disabled={!day.enabled} value={day.exit_time} onChange={(event) => setSchedules(schedules.map((value, position) => position === index ? { ...value, exit_time: event.target.value } : value))} /></div></div></div>)}</div><Button className="settings-save h-12 w-full" disabled={busy} aria-busy={busy || undefined}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{busy ? "Guardando…" : "Guardar configuración"}</Button></form></section>}

    {tab === "monitor" && dashboard.profile.role === "admin" && <section className="space-y-5 py-5"><div><h2 className="text-lg font-semibold">Rendimiento del sistema</h2><p className="text-sm text-zinc-500">Salud global, usuarios y prevención de fallos.</p></div>{adminHealth ? <><div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><MetricCard label="Usuarios" value={String(adminHealth.users?.total || 0)} /><MetricCard label="Automatizaciones" value={String(adminHealth.users?.enabled || 0)} /><MetricCard label="Último ciclo" value={adminHealth.latestRuns[0]?.status || "—"} detail={timeLabel(adminHealth.latestRuns[0]?.started_at)} /><MetricCard label="Duración" value={`${adminHealth.latestRuns[0]?.duration_ms || 0}ms`} /></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><h3 className="font-semibold">Personas</h3><div className="mt-3 divide-y divide-zinc-100">{adminUsers.map((person) => <div key={person.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{person.display_name}</p><p className="text-zinc-500">@{person.username} · {person.role === "admin" ? "Administrador" : "Usuario"}</p></div><span className={person.enabled ? "text-emerald-700" : "text-zinc-500"}>{person.enabled ? "Activo" : "Parado"}</span></div>)}</div><form className="mt-4 grid gap-3 border-t border-zinc-100 pt-4 sm:grid-cols-2" onSubmit={createAccount}><div><Label htmlFor="account-name">Nombre</Label><Input id="account-name" required value={userForm.displayName} onChange={(event) => setUserForm({ ...userForm, displayName: event.target.value })} /></div><div><Label htmlFor="account-user">Usuario</Label><Input id="account-user" required value={userForm.username} onChange={(event) => setUserForm({ ...userForm, username: event.target.value })} /></div><div><Label htmlFor="account-password">Contraseña inicial</Label><Input id="account-password" type="password" minLength={10} required value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} /></div><div><Label htmlFor="account-pin">PIN de Timenet</Label><Input id="account-pin" type="password" inputMode="numeric" required value={userForm.timenetPin} onChange={(event) => setUserForm({ ...userForm, timenetPin: event.target.value.replace(/\D/g, "") })} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={userForm.role === "admin"} onChange={(event) => setUserForm({ ...userForm, role: event.target.checked ? "admin" : "user" })} />También administrador</label><Button disabled={busy}>Crear usuario</Button></form></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><h3 className="font-semibold">Últimas ejecuciones del programador</h3><div className="mt-3 divide-y divide-zinc-100">{adminHealth.latestRuns.slice(0, 10).map((run) => <div key={run.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{timeLabel(run.started_at)}</p><p className="text-zinc-500">{run.users_scanned} usuarios · {run.jobs_processed} trabajos</p></div><span className={run.status === "success" ? "text-emerald-700" : "text-red-700"}>{run.status}</span></div>)}</div></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><h3 className="font-semibold">Fallos recientes</h3><div className="mt-3 space-y-3">{adminHealth.recentFailures.map((failure) => <div key={failure.id} className="rounded-lg bg-red-50 p-3 text-sm"><p className="font-medium text-red-900">{failure.display_name} · {failure.action === "entry" ? "Entrada" : "Salida"}</p><p className="mt-1 text-red-800">{failure.error_message}</p></div>)}{!adminHealth.recentFailures.length && <p className="text-sm text-zinc-500">No hay fallos recientes.</p>}</div></div></> : <p role="status" className="text-sm text-zinc-500">Cargando métricas…</p>}</section>}
    </div>
    <nav className="app-tabbar grid shrink-0 gap-2" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }} aria-label="Secciones">{tabs.map(([value, Icon, label]) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)} className={`relative flex min-h-14 min-w-0 touch-manipulation flex-col items-center justify-center gap-1 rounded-2xl text-xs font-semibold transition-colors active:scale-95 ${tab === value ? "bg-emerald-50 text-emerald-800" : "text-zinc-600 hover:bg-zinc-50"}`}><span className="relative"><Icon aria-hidden="true" className="h-6 w-6" />{value === "notifications" && unread > 0 && <span className="absolute -right-2 -top-1 grid min-w-3.5 place-items-center rounded-full bg-rose-500 px-1 text-[9px] text-white">{unread}</span>}</span><span>{label}</span></button>)}</nav>
  </div></main>;
}
