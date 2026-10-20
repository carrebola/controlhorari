"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, Bell, CalendarClock, CheckCircle2, Clock3, House, LogOut, RefreshCcw, Save, Settings, ShieldAlert, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DailyPunches } from "@/components/daily-punches";
import { MobileSetup, removeDevicePush } from "@/components/mobile-setup";

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

const dayNames = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const statusLabels: Record<JobStatus, string> = { scheduled: "Programado", claimed: "Preparando", running: "Ejecutando", success: "Correcto", failed: "Fallido", uncertain: "Revisar", skipped: "Omitido", missed: "No ejecutado" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/backend${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) }, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "No se pudo completar la petición.");
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
  return <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"><p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>{detail && <p className="mt-1 text-xs text-zinc-500">{detail}</p>}</div>;
}

export default function Home() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [adminHealth, setAdminHealth] = useState<AdminHealth | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<Tab>("home");
  const [punching, setPunching] = useState<"entry" | "exit" | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
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

  useEffect(() => {
    api<Dashboard>("/me")
      .then((data) => { applyDashboard(data); if (new URLSearchParams(window.location.search).get("view") === "notifications") setTab("notifications"); })
      .catch((cause) => { if (cause instanceof Error && !/Sesión no válida/.test(cause.message)) setError(cause.message); })
      .finally(() => setLoading(false));
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  }, [applyDashboard]);
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
    try { await api("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); setPassword(""); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo iniciar sesión."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await removeDevicePush().catch(() => { /* Logout still clears the session if the device is offline. */ });
    setBusy(true); try { await api("/auth/logout", { method: "POST", body: "{}" }); } catch { /* The proxy still clears the local cookie. */ }
    setDashboard(null); setBusy(false); setTab("home"); setNeedsReview(false);
  }

  async function saveConfiguration(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
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
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ ok: true; message: string }>("/me/history/sync", { method: "POST", body: "{}" });
      setMessage(result.message); setNeedsReview(false); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo sincronizar Timenet."); }
    finally { setBusy(false); }
  }

  async function manualPunch(action: "entry" | "exit") {
    if (busy || needsReview) return;
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

  if (loading) return <main className="grid min-h-dvh place-items-center bg-zinc-50"><p role="status" className="text-sm text-zinc-600">Conectando con el servidor…</p></main>;

  if (!dashboard) return <main className="min-h-dvh bg-zinc-50 px-4 py-10 text-zinc-950"><div className="mx-auto max-w-sm"><div className="mb-8 flex items-center gap-3"><div className="rounded-2xl bg-emerald-700 p-3 text-white"><Clock3 className="h-7 w-7" /></div><div><p className="text-sm text-zinc-500">FP Llefià · Timenet</p><h1 className="text-2xl font-semibold">Control Horari</h1></div></div><section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"><h2 className="text-lg font-semibold">Acceder</h2><p className="mt-1 text-sm text-zinc-500">Consulta tus fichajes y controla la automatización.</p><form className="mt-6 space-y-4" onSubmit={signIn}><div><Label htmlFor="username">Usuario</Label><Input id="username" autoComplete="username" className="mt-1 h-12" required value={username} onChange={(event) => setUsername(event.target.value)} /></div><div><Label htmlFor="password">Contraseña</Label><Input id="password" type="password" autoComplete="current-password" className="mt-1 h-12" required value={password} onChange={(event) => setPassword(event.target.value)} /></div><Button className="h-12 w-full" disabled={busy}>{busy ? "Accediendo…" : "Entrar"}</Button></form>{error && <p role="alert" className="mx-4 mt-2 shrink-0 rounded-2xl bg-red-50 p-3 text-xs text-red-800">{error}</p>}</section></div></main>;

  const tabs: Array<[Tab, LucideIcon, string]> = [["home", House, "Inicio"], ["summary", CalendarClock, "Fichajes"], ["notifications", Bell, "Avisos"], ["settings", Settings, "Ajustes"]];
  if (dashboard.profile.role === "admin") tabs.push(["monitor", Activity, "Monitor"]);
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: dashboard.profile.time_zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
  const entryRecorded = dashboard.events.some((event) => event.local_date === today && event.action === "entry");
  const exitRecorded = dashboard.events.some((event) => event.local_date === today && event.action === "exit");

  return <main className="h-dvh overflow-hidden bg-zinc-200 text-zinc-950"><div className="mx-auto flex h-full w-full max-w-lg flex-col overflow-hidden bg-zinc-50 shadow-xl sm:border-x sm:border-zinc-200">
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-100 bg-white px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
      <div className="min-w-0"><p className="truncate text-[11px] text-zinc-500">{dashboard.profile.display_name}</p><h1 className="whitespace-nowrap text-xl font-bold tracking-tight">Mi jornada<span className="text-emerald-600">.</span></h1></div>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" role="switch" aria-label="Fichaje automático" title={dashboard.profile.enabled ? "Pausar fichaje automático" : "Activar fichaje automático"} aria-checked={Boolean(dashboard.profile.enabled)} disabled={busy} onClick={() => void toggleAutomation()} className="flex min-h-11 w-16 touch-manipulation flex-col items-center justify-center gap-1 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"><span className={`relative block h-7 w-12 rounded-full transition-colors ${dashboard.profile.enabled ? "bg-emerald-600" : "bg-zinc-300"}`}><span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none ${dashboard.profile.enabled ? "translate-x-5" : "translate-x-0"}`} /></span><span className={`text-[9px] font-semibold ${dashboard.profile.enabled ? "text-emerald-700" : "text-zinc-500"}`}>Auto {dashboard.profile.enabled ? "ON" : "OFF"}</span></button>
        <Button className="h-11 w-11 rounded-full bg-zinc-50" variant="ghost" size="icon" title="Sincronizar Timenet" aria-label="Sincronizar Timenet" disabled={busy} onClick={() => void syncHistory()}><RefreshCcw className={`h-5 w-5 ${busy ? "animate-spin" : ""}`} /></Button>
        <Button className="h-11 w-11 rounded-full" variant="ghost" size="icon" title="Cerrar sesión" aria-label="Cerrar sesión" onClick={() => void signOut()} disabled={busy}><LogOut className="h-4 w-4" /></Button>
      </div>
    </header>
    {error && <p role="alert" className="mx-4 mt-2 shrink-0 rounded-2xl bg-red-50 p-3 text-xs text-red-800">{error}</p>}{message && <p role="status" className="mx-4 mt-2 shrink-0 rounded-2xl bg-emerald-50 p-3 text-xs text-emerald-800">{message}</p>}

    <div className={`min-h-0 flex-1 px-4 ${tab === "summary" || tab === "home" ? "flex flex-col overflow-hidden" : "overflow-y-auto overscroll-contain"}`}>
    {tab === "home" && <section className="flex min-h-0 flex-1 flex-col gap-3 pt-4 pb-3">
      <div className="shrink-0"><h2 className="text-xl font-bold tracking-tight">Hoy</h2><p className="mt-1 text-xs text-zinc-500">Tu jornada de un vistazo</p></div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl">
        <DailyPunches calendar={dashboard.calendar ?? []} events={dashboard.events} jobs={dashboard.jobs} timeZone={dashboard.profile.time_zone} enabled={Boolean(dashboard.profile.enabled)} todayOnly />
      </div>
      <div className="shrink-0 space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <button type="button" disabled={busy || needsReview || entryRecorded} onClick={() => void manualPunch("entry")} className="flex min-h-24 touch-manipulation flex-col items-center justify-center gap-2 rounded-3xl bg-emerald-800 p-4 text-white shadow-sm transition-colors active:bg-emerald-900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300"><ArrowDownLeft aria-hidden="true" className="h-7 w-7" /><span className="text-sm font-semibold">{punching === "entry" ? "Fichando…" : entryRecorded ? "Entrada registrada" : "Fichar entrada"}</span></button>
          <button type="button" disabled={busy || needsReview || exitRecorded} onClick={() => void manualPunch("exit")} className="flex min-h-24 touch-manipulation flex-col items-center justify-center gap-2 rounded-3xl bg-rose-50 p-4 text-rose-800 ring-1 ring-inset ring-rose-100 transition-colors active:bg-rose-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-rose-300"><ArrowUpRight aria-hidden="true" className="h-7 w-7" /><span className="text-sm font-semibold">{punching === "exit" ? "Fichando…" : exitRecorded ? "Salida registrada" : "Fichar salida"}</span></button>
        </div>
        <p className="text-center text-[11px] text-zinc-500">{needsReview ? "Sincroniza para revisar el último fichaje antes de continuar." : "Fichaje manual en Timenet · se registra al pulsar"}</p>
      </div>
    </section>}
    {tab === "summary" && <section className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
      {nextJob && <div className="flex shrink-0 items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2"><div className="text-xs"><span className="text-zinc-500">Próximo · </span><span className="font-medium">{nextJob.action === "entry" ? "Entrada" : "Salida"}</span><span className="ml-2 text-zinc-500">{timeLabel(nextJob.target_at)}</span></div><StatusBadge status={nextJob.status} /></div>}
      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 pb-2 text-base font-semibold">Fichajes de Timenet</h2>
        <div data-punch-scroll role="region" aria-label="Fichajes de Timenet" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl px-0.5 pb-3 [scrollbar-gutter:stable]">
          <DailyPunches calendar={dashboard.calendar ?? []} events={dashboard.events} jobs={dashboard.jobs} timeZone={dashboard.profile.time_zone} enabled={Boolean(dashboard.profile.enabled)} />
        </div>
      </div>
    </section>}

    {tab === "notifications" && <section className="py-5"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-semibold">Avisos</h2><p className="text-sm text-zinc-500">Resultados y problemas de los fichajes.</p></div>{unread > 0 && <Button variant="secondary" onClick={() => void markNotificationsRead()}>Marcar leídos</Button>}</div><div className="space-y-3">{dashboard.notifications.map((notice) => <article key={notice.id} className={`rounded-xl border bg-white p-4 ${notice.read_at ? "border-zinc-200" : "border-emerald-300"}`}><div className="flex gap-3">{notice.level === "success" ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /> : notice.level === "error" ? <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" /> : <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />}<div><p className="font-medium">{notice.title}</p><p className="mt-1 text-sm text-zinc-600">{notice.message}</p><p className="mt-2 text-xs text-zinc-400">{timeLabel(notice.created_at)}</p></div></div></article>)}{!dashboard.notifications.length && <p className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-500">No hay avisos.</p>}</div></section>}

    <MobileSetup visible={tab === "settings"} />
    {tab === "settings" && <section className="py-5"><div className="mb-5"><h2 className="text-lg font-semibold">Configuración</h2><p className="text-sm text-zinc-500">Los cambios se guardan en el servidor y funcionan aunque el móvil esté apagado.</p></div><form className="space-y-4 pb-4" onSubmit={saveConfiguration}><div className="rounded-xl border border-zinc-200 bg-white p-4"><Label htmlFor="margin">Margen aleatorio (± segundos)</Label><Input id="margin" className="mt-2 h-11" type="number" min={0} max={3600} value={margin} onChange={(event) => setMargin(Number(event.target.value))} /></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><Label htmlFor="new-pin">Cambiar PIN de Timenet</Label><Input id="new-pin" className="mt-2 h-11" type="password" inputMode="numeric" autoComplete="off" placeholder="Déjalo vacío para conservarlo" value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ""))} /></div><div className="space-y-3"><h3 className="font-semibold">Horario semanal</h3>{schedules.map((day, index) => <div key={day.weekday} className="rounded-xl border border-zinc-200 bg-white p-4"><label className="flex items-center gap-3 font-medium"><input type="checkbox" className="h-5 w-5 accent-emerald-600" checked={Boolean(day.enabled)} onChange={(event) => setSchedules(schedules.map((value, position) => position === index ? { ...value, enabled: event.target.checked ? 1 : 0 } : value))} />{dayNames[day.weekday]}</label><div className="mt-3 grid grid-cols-2 gap-3"><div><Label htmlFor={`entry-${day.weekday}`}>Entrada</Label><Input id={`entry-${day.weekday}`} className="mt-1 h-11" type="time" disabled={!day.enabled} value={day.entry_time} onChange={(event) => setSchedules(schedules.map((value, position) => position === index ? { ...value, entry_time: event.target.value } : value))} /></div><div><Label htmlFor={`exit-${day.weekday}`}>Salida</Label><Input id={`exit-${day.weekday}`} className="mt-1 h-11" type="time" disabled={!day.enabled} value={day.exit_time} onChange={(event) => setSchedules(schedules.map((value, position) => position === index ? { ...value, exit_time: event.target.value } : value))} /></div></div></div>)}</div><Button className="h-12 w-full" disabled={busy}><Save className="h-4 w-4" />{busy ? "Guardando…" : "Guardar configuración"}</Button></form></section>}

    {tab === "monitor" && dashboard.profile.role === "admin" && <section className="space-y-5 py-5"><div><h2 className="text-lg font-semibold">Rendimiento del sistema</h2><p className="text-sm text-zinc-500">Salud global, usuarios y prevención de fallos.</p></div>{adminHealth ? <><div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><MetricCard label="Usuarios" value={String(adminHealth.users?.total || 0)} /><MetricCard label="Automatizaciones" value={String(adminHealth.users?.enabled || 0)} /><MetricCard label="Último ciclo" value={adminHealth.latestRuns[0]?.status || "—"} detail={timeLabel(adminHealth.latestRuns[0]?.started_at)} /><MetricCard label="Duración" value={`${adminHealth.latestRuns[0]?.duration_ms || 0}ms`} /></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><h3 className="font-semibold">Personas</h3><div className="mt-3 divide-y divide-zinc-100">{adminUsers.map((person) => <div key={person.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{person.display_name}</p><p className="text-zinc-500">@{person.username} · {person.role === "admin" ? "Administrador" : "Usuario"}</p></div><span className={person.enabled ? "text-emerald-700" : "text-zinc-500"}>{person.enabled ? "Activo" : "Parado"}</span></div>)}</div><form className="mt-4 grid gap-3 border-t border-zinc-100 pt-4 sm:grid-cols-2" onSubmit={createAccount}><div><Label htmlFor="account-name">Nombre</Label><Input id="account-name" required value={userForm.displayName} onChange={(event) => setUserForm({ ...userForm, displayName: event.target.value })} /></div><div><Label htmlFor="account-user">Usuario</Label><Input id="account-user" required value={userForm.username} onChange={(event) => setUserForm({ ...userForm, username: event.target.value })} /></div><div><Label htmlFor="account-password">Contraseña inicial</Label><Input id="account-password" type="password" minLength={10} required value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} /></div><div><Label htmlFor="account-pin">PIN de Timenet</Label><Input id="account-pin" type="password" inputMode="numeric" required value={userForm.timenetPin} onChange={(event) => setUserForm({ ...userForm, timenetPin: event.target.value.replace(/\D/g, "") })} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={userForm.role === "admin"} onChange={(event) => setUserForm({ ...userForm, role: event.target.checked ? "admin" : "user" })} />También administrador</label><Button disabled={busy}>Crear usuario</Button></form></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><h3 className="font-semibold">Últimas ejecuciones del programador</h3><div className="mt-3 divide-y divide-zinc-100">{adminHealth.latestRuns.slice(0, 10).map((run) => <div key={run.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium">{timeLabel(run.started_at)}</p><p className="text-zinc-500">{run.users_scanned} usuarios · {run.jobs_processed} trabajos</p></div><span className={run.status === "success" ? "text-emerald-700" : "text-red-700"}>{run.status}</span></div>)}</div></div><div className="rounded-xl border border-zinc-200 bg-white p-4"><h3 className="font-semibold">Fallos recientes</h3><div className="mt-3 space-y-3">{adminHealth.recentFailures.map((failure) => <div key={failure.id} className="rounded-lg bg-red-50 p-3 text-sm"><p className="font-medium text-red-900">{failure.display_name} · {failure.action === "entry" ? "Entrada" : "Salida"}</p><p className="mt-1 text-red-800">{failure.error_message}</p></div>)}{!adminHealth.recentFailures.length && <p className="text-sm text-zinc-500">No hay fallos recientes.</p>}</div></div></> : <p role="status" className="text-sm text-zinc-500">Cargando métricas…</p>}</section>}
    </div>
    <nav className="grid shrink-0 gap-1 border-t border-zinc-200 bg-white px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }} aria-label="Secciones">{tabs.map(([value, Icon, label]) => <button key={value} type="button" aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)} className={`relative flex min-h-14 min-w-0 touch-manipulation flex-col items-center justify-center gap-1 rounded-2xl text-[11px] font-semibold transition-colors active:scale-95 ${tab === value ? "bg-emerald-50 text-emerald-800" : "text-zinc-400 hover:bg-zinc-50"}`}><span className="relative"><Icon aria-hidden="true" className="h-5 w-5" />{value === "notifications" && unread > 0 && <span className="absolute -right-2 -top-1 grid min-w-3.5 place-items-center rounded-full bg-rose-500 px-1 text-[9px] text-white">{unread}</span>}</span><span>{label}</span></button>)}</nav>
  </div></main>;
}
