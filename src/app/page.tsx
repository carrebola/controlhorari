"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Clock3, History, Settings, ArrowLeft, RefreshCcw, Save, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HistoryDay, type MarkSource } from "@/components/history-day";

type Result = { ok: boolean; message?: string; dashboardText?: string; calendar?: { schedule?: AgendaDay[]; error?: string }; userSchedule?: { date: string; intervals: { entry: string; exit: string }[]; source: string }[]; history?: { markSources?: Record<string, MarkSource[]>; rows: string[][]; planned: string; worked: string; difference: string } };
const days = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
type Day = { enabled: boolean; entry: string; exit: string };
type AgendaDay = { date: string; weekday: number; kind?: string; intervals: { entry: string; exit: string }[] };
export default function Home() {
  const [pin, setPin] = useState("");
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [calendarBusy, setCalendarBusy] = useState(false);
  const requestId = useRef(0);
  const latestResult = useRef<Result | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [view, setView] = useState("today");
  const [automatic, setAutomatic] = useState(false);
  const [schedule, setSchedule] = useState<Day[]>(days.map((_, i) => ({ enabled: i < 5, entry: "09:00", exit: "17:00" })));
  const [notice, setNotice] = useState("");
  const [margin, setMargin] = useState(60);
  const [calculated, setCalculated] = useState<Record<string, { entry: string; exit: string }>>({});
  const [today, setToday] = useState("");
  const [restored, setRestored] = useState(false);
  async function load(code: string) {
    const id = ++requestId.current;
    const cacheKey = `timenet-data:${code}`;
    let cached: Result | null = null;
    try {
      const stored = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (stored?.version === 1 && stored.data?.ok && Array.isArray(stored.data.history?.rows)) cached = stored.data;
    } catch { /* A damaged cache can be replaced by the live response. */ }
    latestResult.current = cached;
    setResult(cached);
    const saveResult = (data: Result) => {
      latestResult.current = data;
      setResult(data);
      if (data.ok) persist(cacheKey, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), data }));
    };
    setBusy(true);
    setCalendarBusy(false);
    try {
      const payload = { pin: code, mode: "portal", url: "https://timenet-wcp.gpisoftware.com/login/1b64e567-7e18-40a5-b545-f0ab35cc1810" };
      const response = await fetch("/api/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, includeCalendar: false }) });
      const data = await response.json() as Result;
      if (id !== requestId.current) return;
      if (data.history) {
        data.history.rows = data.history.rows.map((cells) => cells.map((value, column) =>
          column === 1 ? value.replace(/(\d{1,2}:\d{2})\s*(?=\d{1,2}:\d{2})/g, "$1 · ") : value,
        ));
        try {
          const journal = JSON.parse(localStorage.getItem(`timenet-punches:${code}`) || "{}");
          data.history.markSources = Object.fromEntries(data.history.rows.map((cells) => {
            const times = /\s+a\s+/.test(cells[1]) ? [] : cells[1].match(/\d{1,2}:\d{2}/g) || [];
            return [cells[0], times.map((time, index) => journal[`${cells[0]}:${index % 2 === 0 ? "entry" : "exit"}`]?.time?.slice(0, 5) === time ? "automatic" : "unknown")];
          }));
        } catch { /* Origin remains unknown without a confirmed local record. */ }
      }
      if (data.ok) saveResult({ ...data, calendar: cached?.calendar || data.calendar });
      else if (cached) setNotice(`${data.message || "No se pudo actualizar."} Mostrando datos guardados.`);
      else setResult(data);
      if (data.ok) {
        setKnown(true); persist("timenet-pin", code);
        setBusy(false);
        setCalendarBusy(true);
        void fetch("/api/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, includeCalendar: true }) })
          .then((response) => response.json() as Promise<Result>)
          .then((agenda) => {
            if (id !== requestId.current || !latestResult.current) return;
            if (agenda.calendar?.schedule?.length) saveResult({ ...latestResult.current, calendar: agenda.calendar });
            else if (!latestResult.current.calendar?.schedule?.length) saveResult({ ...latestResult.current, calendar: agenda.calendar || { error: agenda.message || "No se pudo consultar la agenda." } });
          })
          .catch(() => { if (id === requestId.current) setNotice("No se pudo actualizar la agenda. Se conservan los datos guardados."); })
          .finally(() => { if (id === requestId.current) setCalendarBusy(false); });
      }
    } catch { if (id === requestId.current) { if (cached) setNotice("Sin conexión. Mostrando datos guardados."); else setResult({ ok: false, message: "No se pudo conectar con Timenet." }); } }
    finally { if (id === requestId.current) setBusy(false); }
  }
  function persist(key: string, value: string) { try { localStorage.setItem(key, value); } catch { setNotice("No se pudo guardar en este dispositivo."); } }
  useEffect(() => {
    const timer = window.setTimeout(() => {
    setToday(new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date()));
    try {
      const code = localStorage.getItem("timenet-pin");
      setAutomatic(localStorage.getItem("timenet-auto") === "true");
      const storedMargin = Number(localStorage.getItem("timenet-margin") ?? 60);
      if (Number.isInteger(storedMargin) && storedMargin >= 0 && storedMargin <= 3600) setMargin(storedMargin);
      const saved = JSON.parse(localStorage.getItem("timenet-schedule") || "null");
      if (Array.isArray(saved) && saved.length === 7 && saved.every((s) => typeof s.enabled === "boolean" && /^\d{2}:\d{2}$/.test(s.entry) && /^\d{2}:\d{2}$/.test(s.exit))) setSchedule(saved);
      if (code && /^\d+$/.test(code)) { setPin(code); setKnown(true); void load(code); }
    } catch { setNotice("No se pudieron recuperar las preferencias."); }
    setRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  // Restore this device's preferences once when opening the app.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!restored) return;
    try { localStorage.setItem("timenet-schedule", JSON.stringify(schedule)); }
    catch { /* Explicit saving reports storage errors to the user. */ }
  }, [schedule, restored]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!pin || !result?.ok) return;
      const previewKey = `timenet-preview:${pin}`;
      const signature = JSON.stringify({ schedule, margin });
      let previous: Record<string, { entry: string; exit: string }> = {};
      try {
        const stored = JSON.parse(localStorage.getItem(previewKey) || "null");
        if (stored?.signature === signature && stored.values && typeof stored.values === "object") previous = stored.values;
      } catch { /* Invalid saved previews are regenerated. */ }
      const preview: Record<string, { entry: string; exit: string }> = {};
      const randomTime = (time: string) => {
        const [hour, minute] = time.split(":").map(Number);
        const offset = Math.floor(Math.random() * (2 * margin + 1)) - margin;
        const seconds = ((hour * 3600 + minute * 60 + offset) % 86400 + 86400) % 86400;
        return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map((n) => String(n).padStart(2, "0")).join(":");
      };
      for (const cells of result?.history?.rows || []) {
        const agendaDay = result?.calendar?.schedule?.find((day) => day.date === cells[0]);
        if (agendaDay ? !agendaDay.intervals.length : !/\s+a\s+/.test(cells[1])) continue;
        const [day, month, year] = cells[0].split("/").map(Number);
        const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
        const configured = schedule[weekday];
        if (configured?.enabled) {
          const saved = previous[cells[0]];
          preview[cells[0]] = saved && /^\d{2}:\d{2}:\d{2}$/.test(saved.entry) && /^\d{2}:\d{2}:\d{2}$/.test(saved.exit) ? saved : { entry: randomTime(configured.entry), exit: randomTime(configured.exit) };
        }
      }
      setCalculated(preview);
      try { localStorage.setItem(previewKey, JSON.stringify({ signature, values: { ...previous, ...preview } })); } catch { setNotice("No se pudieron guardar las horas calculadas."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [result, schedule, margin, pin]);
  useEffect(() => {
    if (!automatic || !known || !pin || !result?.ok) return;
    let running = false;
    let stopped = false;
    const tick = async () => {
      if (running || stopped) return;
      const now = new Date();
      const date = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
      const agenda = result.calendar?.schedule?.find((day) => day.date === date);
      const plan = calculated[date];
      if (!agenda?.intervals.length || !plan || !schedule[agenda.weekday]?.enabled) return;
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now);
      const seconds = (value: string) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
      for (const action of ["entry", "exit"] as const) {
        const delay = seconds(time) - seconds(plan[action]);
        if (delay < 0 || delay > 90 || stopped) continue;
        const execute = async () => {
          const storageKey = `timenet-punches:${pin}`;
          const key = `${date}:${action}`;
          let journal;
          try {
            if (localStorage.getItem("timenet-auto") !== "true") return;
            journal = JSON.parse(localStorage.getItem(storageKey) || "{}");
            if (journal[key]) return;
            journal[key] = { status: "pending", target: plan[action] };
            localStorage.setItem(storageKey, JSON.stringify(journal));
          } catch { setNotice("No se puede fichar automáticamente sin guardar el estado en el dispositivo."); return; }
          running = true;
          try {
            const response = await fetch("/api/punch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin, date, action, target: plan[action] }) });
            const outcome = await response.json();
            journal = JSON.parse(localStorage.getItem(storageKey) || "{}");
            journal[key] = { ...journal[key], status: outcome.ok ? outcome.skipped ? "skipped" : "confirmed" : "error", time: outcome.time, message: outcome.message };
            localStorage.setItem(storageKey, JSON.stringify(journal));
            setNotice(outcome.ok ? outcome.skipped ? outcome.message : `${action === "entry" ? "Entrada" : "Salida"} automática registrada a las ${outcome.time}.` : outcome.message);
            if (outcome.ok || outcome.uncertain) void load(pin);
          } catch { setNotice("No se pudo confirmar el fichaje automático. Revisa el registro antes de repetir."); }
          finally { running = false; }
        };
        if (navigator.locks) await navigator.locks.request(`timenet-punch:${pin}`, execute);
        else await execute();
      }
    };
    const timer = window.setInterval(() => void tick(), 5000);
    void tick();
    return () => { stopped = true; window.clearInterval(timer); };
  // The timer uses the current loaded schedule and stops when automation is disabled.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automatic, known, pin, result, calculated, schedule]);
  const row = result?.history?.rows.find((r) => r[0] === today);
  const todayAgenda = result?.calendar?.schedule?.find((day) => day.date === today);
  function login(e: FormEvent) { e.preventDefault(); void load(pin); }
  return <main className="min-h-dvh bg-zinc-50 text-zinc-950"><div className="mx-auto max-w-xl px-4 py-5">
    <header className="flex items-center justify-between border-b border-zinc-200 pb-4"><div className="flex items-center gap-3"><Clock3 className="text-emerald-700" /><div><p className="text-xs text-zinc-500">FP Llefià · Timenet</p><h1 className="text-xl font-semibold">Mi jornada</h1></div></div><Button variant="ghost" size="icon" aria-label="Configuración" title="Configuración" onClick={() => { setNotice(""); setView("schedule"); }}><Settings className="h-5 w-5" /></Button></header>
    {!known && view !== "schedule" ? <section className="space-y-5 py-10"><h2 className="text-xl font-semibold">Acceder a mi jornada</h2><Button className="h-12 w-full" onClick={() => setView("schedule")}><Settings className="h-4 w-4" />Configurar PIN</Button></section> : <>
      {view !== "today" && <Button variant="ghost" className="mt-4" onClick={() => setView("today")}><ArrowLeft className="h-4 w-4" />Hoy</Button>}
      {view === "today" && <section className="py-6"><div className="flex items-center justify-between"><div><h2 className="text-lg font-semibold">Registro de hoy</h2><p className="text-sm text-zinc-500">{today}</p></div><Button variant="ghost" size="icon" title="Actualizar" aria-label="Actualizar" disabled={busy} onClick={() => void load(pin)}><RefreshCcw className={`h-5 w-5 ${busy ? "animate-spin" : ""}`} /></Button></div>
        {result?.ok && calendarBusy && !result.calendar?.schedule?.length && <p role="status" className="mt-2 text-sm text-zinc-500">Consultando horario previsto…</p>}
        {!busy && result?.calendar?.error && <p className="mt-2 text-xs text-zinc-500">{result.calendar.error}</p>}
        {busy && !result?.ok ? <p className="py-10" role="status">Consultando tu jornada…</p> : result?.ok && <div className="mt-5"><HistoryDay cells={row || [today, "", "", "", ""]} planned={todayAgenda?.intervals} kind={todayAgenda?.kind} calculated={calculated[today]} sources={result.history?.markSources?.[today]} /></div>}
        <div className="flex items-center justify-between gap-4 border-b border-zinc-200 py-6"><div><h3 className="font-medium">Fichaje automático</h3><p className="mt-1 text-xs text-zinc-500">{automatic ? "Activo mientras esta app esté abierta." : "Desactivado"}</p></div><button role="switch" aria-checked={automatic} aria-label="Fichaje automático" className={`relative h-7 w-12 shrink-0 rounded-full ${automatic ? "bg-emerald-600" : "bg-zinc-300"}`} onClick={() => { setAutomatic(!automatic); persist("timenet-auto", String(!automatic)); }}><span className={`absolute left-0 top-1 h-5 w-5 rounded-full bg-white transition-transform ${automatic ? "translate-x-6" : "translate-x-1"}`} /></button></div>
        <div className="grid gap-3 pt-6"><Button variant="secondary" className="h-12 justify-start" onClick={() => setView("history")}><History className="h-5 w-5" />Historial de marcajes</Button></div></section>}
      {view === "history" && <section className="py-6"><h2 className="text-xl font-semibold">Historial de marcajes</h2><div className="mt-4 grid grid-cols-3 gap-3 border-b pb-4">{[["Previstas", result?.history?.planned], ["Trabajadas", result?.history?.worked], ["Diferencia", result?.history?.difference]].map(([label, value]) => <div key={label}><p className="text-xs text-zinc-500">{label}</p><p className="font-semibold">{value || "—"}</p></div>)}</div><div className="mt-5 space-y-3">{result?.history?.rows.map((cells) => { const agenda = result.calendar?.schedule?.find((day) => day.date === cells[0]); return <HistoryDay key={cells[0]} cells={cells} planned={agenda?.intervals} kind={agenda?.kind} calculated={calculated[cells[0]]} sources={result.history?.markSources?.[cells[0]]} />; })}</div></section>}
      {view === "schedule" && <section className="py-6">
        <h2 className="text-xl font-semibold">Configuración</h2>
        <form onSubmit={login} className="space-y-3 border-b border-zinc-200 py-5">
          <Label htmlFor="settings-pin">PIN de Timenet</Label>
          <Input id="settings-pin" type="password" inputMode="numeric" autoComplete="off" required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="h-12" />
          <Button className="h-11 w-full" disabled={busy}><KeyRound className="h-4 w-4" />{busy ? "Comprobando…" : "Guardar PIN y acceder"}</Button>
        </form>
        <form className="space-y-5 py-6" onSubmit={(e) => { e.preventDefault(); persist("timenet-schedule", JSON.stringify(schedule)); setNotice("Horario guardado en este dispositivo."); }}>
        <h2 className="text-xl font-semibold">Horario automático</h2>
        <div className="space-y-2"><Label htmlFor="random-margin">Margen aleatorio (± segundos)</Label><Input id="random-margin" type="number" min={0} max={3600} step={1} value={margin} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 3600) { setMargin(value); persist("timenet-margin", String(value)); } }} /></div>
        {schedule.map((s, index) => <div key={index} className="border-b border-zinc-200 pb-4">
          <label className="flex items-center gap-3 font-medium"><input type="checkbox" className="h-5 w-5 accent-emerald-600" checked={s.enabled} onChange={(e) => setSchedule(schedule.map((d, i) => i === index ? { ...d, enabled: e.target.checked } : d))} />{days[index]}</label>
          <div className="mt-3 grid grid-cols-2 gap-3">{(["entry", "exit"] as const).map((field) => <div key={field}>
            <Label htmlFor={`${index}-${field}`}>{field === "entry" ? "Entrada" : "Salida"}</Label>
            <Input className="mt-1 h-11 min-w-0" id={`${index}-${field}`} type="time" required disabled={!s.enabled} value={s[field]} onChange={(e) => setSchedule(schedule.map((d, i) => i === index ? { ...d, [field]: e.target.value } : d))} />
            <div className="mt-2 space-y-1 text-xs text-amber-800">
              <p className="font-medium">Previsto en agenda</p>
              {result?.calendar?.schedule?.some((day) => day.weekday === index) ? result.calendar.schedule.filter((day) => day.weekday === index).map((day) => <p key={day.date} className="break-words tabular-nums">{day.date}: {day.intervals.map((interval) => interval[field]).join(" · ")}</p>) : <p className="text-zinc-500">{result?.calendar?.error ? "Agenda no disponible" : "Sin horario extraído"}</p>}
            </div>
          </div>)}</div>
        </div>)}
        <Button className="h-12 w-full"><Save className="h-4 w-4" />Guardar horario</Button>
      </form></section>}
    </>}
    {known && view === "schedule" && <section className="border-t border-zinc-200 py-5"><h2 className="text-lg font-semibold">Horario previsto en Timenet</h2>{result?.userSchedule?.length ? <div className="mt-3 divide-y divide-zinc-200">{result.userSchedule.map((day) => <div key={day.date} className="flex flex-wrap justify-between gap-3 py-3"><p className="font-medium">{day.date}</p><div className="text-amber-800">{day.intervals.map((interval, index) => <p key={index} className="tabular-nums">{interval.entry} – {interval.exit}</p>)}</div></div>)}</div> : <p className="mt-3 text-sm text-zinc-500">No se han encontrado intervalos previstos en los datos consultados.</p>}</section>}
    {result?.ok === false && <p role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-800">{result.message}</p>}{notice && <p role="status" className="mt-4 text-sm">{notice}</p>}
  </div></main>;
}
