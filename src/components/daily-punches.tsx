"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Bot, CalendarDays, CheckCheck, ChevronDown, CircleHelp, Hand, LocateFixed, Pause, Shuffle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type Action = "entry" | "exit";
type CalendarDay = { local_date: string; label: string; entry_time: string | null; exit_time: string | null; random_entry_at: number | null; random_exit_at: number | null; margin_seconds: number; synced_at: number };
type Event = { id: string; local_date: string; action: Action; source: "automatic" | "manual" | "unknown"; recorded_time: string };
type Job = { id: string; local_date: string; action: Action; target_at: number; planned_at: number | null; status: string; error_message: string | null };

const statusLabels: Record<string, string> = { scheduled: "Programado", claimed: "Preparando", running: "Ejecutando", success: "Realizado", failed: "Fallido", uncertain: "Revisar", skipped: "Omitido", missed: "No ejecutado" };
const dateKey = (value: string) => value.split("/").reverse().join("-");

function scrollToCard(card: HTMLElement | null) {
  const container = card?.closest<HTMLElement>("[data-punch-scroll]");
  if (!card || !container) return;
  container.scrollTo({
    top: container.scrollTop + card.getBoundingClientRect().top - container.getBoundingClientRect().top - 64,
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
  });
}

function RowLabel({ icon: Icon, label, title, color }: { icon: LucideIcon; label: string; title: string; color: string }) {
  return <span title={title} className="flex items-center gap-2"><span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${color}`}><Icon aria-hidden="true" className="h-3.5 w-3.5" /></span><span>{label}</span></span>;
}

function SummaryMarks({ events, action }: { events: Event[]; action: Action }) {
  const DirectionIcon = action === "entry" ? ArrowDownLeft : ArrowUpRight;
  const label = action === "entry" ? "Entrada" : "Salida";
  const matches = events.filter((event) => event.action === action).sort((a, b) => a.recorded_time.localeCompare(b.recorded_time));
  return <span className={`summary-mark summary-mark-${action} flex min-w-0 flex-col gap-1`}>
    <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-zinc-500"><DirectionIcon aria-hidden="true" className={`h-3 w-3 ${action === "entry" ? "text-emerald-600" : "text-rose-500"}`} />{label}</span>
    <span className="summary-times flex flex-wrap gap-1 tabular-nums">{matches.length ? matches.map((event) => {
      const Icon = event.source === "automatic" ? Bot : event.source === "manual" ? Hand : CircleHelp;
      const source = event.source === "automatic" ? "automático" : event.source === "manual" ? "manual/externo" : "origen sin confirmar";
      return <span key={event.id} aria-label={`${label} ${event.recorded_time}, ${source}`} title={`${label} registrada · ${source}`} className={`inline-flex items-center gap-1 rounded-md px-2 py-3 text-base font-semibold ${event.source === "automatic" ? "bg-emerald-100 text-emerald-800" : event.source === "manual" ? "bg-blue-100 text-blue-800" : "bg-zinc-200 text-zinc-600"}`}><Icon aria-hidden="true" className="h-3 w-3 shrink-0" />{event.recorded_time}</span>;
    }) : <span aria-label={`${label} sin registrar`} className="summary-empty py-1 text-lg text-zinc-500">—<span className="summary-pending">Pendiente</span></span>}</span>
  </span>;
}

export function DailyPunches({ calendar, events, jobs, timeZone, enabled, todayOnly = false }: { calendar: CalendarDay[]; events: Event[]; jobs: Job[]; timeZone: string; enabled: boolean; todayOnly?: boolean }) {
  const [selectedMonth, setSelectedMonth] = useState("");
  const [expandedDays, setExpandedDays] = useState<Record<string, boolean>>({});
  const todayRef = useRef<HTMLElement>(null);
  const today = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
  const dates = [...new Set([...(todayOnly ? [today] : []),...calendar.map((day) => day.local_date), ...events.map((event) => event.local_date), ...jobs.map((job) => job.local_date)])].sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
  const months = [...new Set(dates.map((date) => dateKey(date).slice(0, 7)))];
  const currentMonth = dateKey(today).slice(0, 7);
  const month = months.includes(selectedMonth) ? selectedMonth : months.includes(currentMonth) ? currentMonth : months[0];
  const hasToday = dates.includes(today);
  const scrollToToday = () => scrollToCard(todayRef.current);

  useEffect(() => {
    if (todayOnly || !hasToday || month !== currentMonth) return;
    const frame = requestAnimationFrame(() => {
      scrollToCard(todayRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [hasToday, month, currentMonth, today, todayOnly]);

  const clock = (value: number | null | undefined) => value == null ? "—" : new Intl.DateTimeFormat("es-ES", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(value);
  const marks = (dayEvents: Event[], action: Action, source: Event["source"]) => {
    const matches = dayEvents.filter((event) => event.action === action && event.source === source).sort((a, b) => a.recorded_time.localeCompare(b.recorded_time));
    return matches.length ? <div className="space-y-0.5">{matches.map((event) => <div key={event.id} className="font-semibold">{event.recorded_time}</div>)}</div> : <span className="font-normal text-zinc-300">—</span>;
  };

  if (!dates.length) return <p className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-500">Sincroniza Timenet para cargar el calendario y los fichajes reales.</p>;

  return <div className="space-y-2.5">
    {!todayOnly && <><details className="rounded-2xl border border-zinc-200 bg-white px-4 text-sm text-zinc-600">
      <summary className="flex min-h-12 cursor-pointer items-center font-medium text-zinc-700">Cómo leer los horarios</summary>
      <p className="mt-2 leading-relaxed">Calendario: horario previsto por Timenet. Aleatorio: horario de fichaje guardado (entrada 10 min antes y salida 10 min después del previsto, más tu margen ±); se recalcula al guardar la configuración en días aún sin fichar, y cada mes. Manual: registro manual/externo. Automático: fichaje confirmado por esta aplicación.</p>
      <p className="mt-1 leading-relaxed">El origen de los registros externos se muestra como manual porque esta aplicación no puede confirmar cómo se realizaron. Los días pasados sin cálculo guardado muestran —.</p>
    </details>
    {!enabled && <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800"><Pause aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />Automatización pausada · cálculo solo orientativo</p>}
    <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-zinc-50/95 py-2 backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2">
      <label title="Elegir mes" className="relative grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-zinc-200 bg-white text-zinc-600 focus-within:ring-2 focus-within:ring-emerald-500"><CalendarDays aria-hidden="true" className="h-5 w-5" /><span className="sr-only">Mes de fichajes</span>
        <select aria-label="Mes de fichajes" value={month} onChange={(event) => setSelectedMonth(event.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0">
          {months.map((value) => <option key={value} value={value}>{new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`))}</option>)}
        </select>
      </label>
      <span className="truncate text-sm font-semibold capitalize text-zinc-600">{month && new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`))}</span>
      </div>
      <button type="button" disabled={!hasToday} onClick={() => { setSelectedMonth(currentMonth); if (month === currentMonth) scrollToToday(); }} className="flex min-h-12 shrink-0 touch-manipulation items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 transition-colors hover:bg-emerald-100 disabled:opacity-40"><LocateFixed aria-hidden="true" className="h-3.5 w-3.5" />Hoy</button>
    </div>
    </>}
    {dates.filter((date) => {
      const weekday = new Date(`${dateKey(date)}T12:00:00Z`).getUTCDay();
      return todayOnly ? date === today : dateKey(date).startsWith(month) && weekday !== 0 && weekday !== 6;
    }).map((date) => {
      const day = calendar.find((item) => item.local_date === date);
      const dayEvents = events.filter((event) => event.local_date === date);
      const dayJobs = jobs.filter((job) => job.local_date === date);
      const entryJob = dayJobs.find((job) => job.action === "entry");
      const exitJob = dayJobs.find((job) => job.action === "exit");
      const hasManual = dayEvents.some((event) => event.source === "manual");
      const hasAutomatic = dayEvents.some((event) => event.source === "automatic");
      const hasUnknown = dayEvents.some((event) => event.source === "unknown");
      const isToday = date === today;
      const inactive = day && !day.entry_time && !dayEvents.length && !dayJobs.length;
      const origin = hasManual && hasAutomatic ? "Mixto" : hasAutomatic ? "Automático" : hasManual ? "Manual" : hasUnknown ? "Sin confirmar" : "Sin fichajes";
      const OriginIcon = hasManual && hasAutomatic ? CheckCheck : hasAutomatic ? Bot : hasManual ? Hand : CircleHelp;
      const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "UTC" }).format(new Date(`${dateKey(date)}T12:00:00Z`));
      const planned = (job: Job | undefined, fallback: number | null | undefined) => clock(job?.planned_at ?? fallback);
      const expanded = expandedDays[date] ?? todayOnly;
      const panelId = `punches-${dateKey(date)}`;
      return <article key={date} ref={isToday ? todayRef : undefined} data-date={date} aria-label={`Fichajes del ${date}`} className={`daily-card ${todayOnly ? "daily-card-featured" : ""} scroll-mt-16 overflow-hidden rounded-2xl border ${isToday ? "border-emerald-400 bg-white shadow-sm ring-2 ring-emerald-100" : inactive ? "border-zinc-200/80 bg-zinc-100/50" : "border-zinc-200 bg-white shadow-sm"}`}>
        <button type="button" aria-expanded={expanded} aria-controls={panelId} aria-label={`${expanded ? "Ocultar" : "Ver"} detalle del ${date}`} onClick={() => setExpandedDays((previous) => ({ ...previous, [date]: !previous[date] }))} className={`block w-full px-4 py-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500 ${isToday ? "bg-emerald-50 hover:bg-emerald-100/70" : inactive ? "hover:bg-zinc-100" : "bg-zinc-50/80 hover:bg-zinc-100"}`}>
          <span className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2"><div><h3 className={`text-base font-bold tabular-nums ${isToday ? "text-emerald-950" : inactive ? "text-zinc-500" : "text-zinc-900"}`}>{date}</h3><p className="text-sm capitalize text-zinc-600">{weekday}</p></div>{isToday && <span className="rounded-md bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Hoy</span>}</div>
          <span className="flex min-w-0 items-center gap-2">{inactive ? <span className="truncate text-xs text-zinc-500">{day.label}</span> : <span title={hasManual ? "Incluye registros manuales o externos a esta aplicación" : origin} className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold ${hasAutomatic && hasManual ? "bg-violet-100 text-violet-800" : hasAutomatic ? "bg-emerald-100 text-emerald-800" : hasManual ? "bg-blue-100 text-blue-800" : "bg-zinc-100 text-zinc-500"}`}><OriginIcon aria-hidden="true" className="h-3 w-3" />{origin}</span>}<ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} /></span>
          </span>
          {!inactive && <span className="mt-2 grid grid-cols-2 gap-3 border-t border-zinc-200/60 pt-2"><SummaryMarks events={dayEvents} action="entry" /><SummaryMarks events={dayEvents} action="exit" /></span>}
        </button>
        <div id={panelId} hidden={!expanded}>
        {inactive && <p className="border-t border-zinc-200 px-3 py-3 text-xs text-zinc-500">{day.label} · Sin turno ni fichajes registrados.</p>}
        {!inactive && <table className="punch-detail w-full table-fixed text-sm"><caption className="sr-only">Entrada y salida del {date}</caption>
          <thead><tr className="text-xs uppercase tracking-wide text-zinc-500"><th className="w-[38%] px-3 py-3 text-left font-medium">Horario</th><th className="px-1 py-3 font-medium"><span className="inline-flex items-center gap-1"><ArrowDownLeft aria-hidden="true" className="h-3 w-3 text-emerald-600" />Entrada</span></th><th className="px-1 py-3 font-medium"><span className="inline-flex items-center gap-1"><ArrowUpRight aria-hidden="true" className="h-3 w-3 text-rose-500" />Salida</span></th></tr></thead>
          <tbody className="tabular-nums">
            <tr className="border-t border-zinc-100"><th className="px-3 py-3 text-left font-medium text-zinc-600"><RowLabel icon={CalendarDays} label="Previsto" title={day?.label ?? "Calendario sin sincronizar"} color="bg-zinc-100 text-zinc-500" /></th><td className="px-1 py-3 text-center text-zinc-600">{day?.entry_time ?? "—"}</td><td className="px-1 py-3 text-center text-zinc-600">{day?.exit_time ?? "—"}</td></tr>
            <tr className="border-t border-amber-100/70 bg-amber-50/60"><th className="px-3 py-3 text-left font-medium text-amber-900"><RowLabel icon={Shuffle} label="Aleatorio" title={`Automático calculado · margen ±${day?.margin_seconds ?? 0} s`} color="bg-amber-100 text-amber-700" /></th><td className="px-1 py-3 text-center font-medium text-amber-900">{planned(entryJob, day?.random_entry_at)}</td><td className="px-1 py-3 text-center font-medium text-amber-900">{planned(exitJob, day?.random_exit_at)}</td></tr>
            <tr className="border-t border-blue-100/60 bg-blue-50/40"><th className="px-3 py-3 text-left font-medium text-blue-800"><RowLabel icon={Hand} label="Manual" title="Fichaje manual/externo registrado" color="bg-blue-100 text-blue-700" /></th><td className="px-1 py-3 text-center text-blue-800">{marks(dayEvents, "entry", "manual")}</td><td className="px-1 py-3 text-center text-blue-800">{marks(dayEvents, "exit", "manual")}</td></tr>
            <tr className="border-t border-emerald-100/60 bg-emerald-50/40"><th className="px-3 py-3 text-left font-medium text-emerald-800"><RowLabel icon={Bot} label="Automático" title="Fichaje automático registrado" color="bg-emerald-100 text-emerald-700" /></th><td className="px-1 py-3 text-center text-emerald-800">{marks(dayEvents, "entry", "automatic")}</td><td className="px-1 py-3 text-center text-emerald-800">{marks(dayEvents, "exit", "automatic")}</td></tr>
            {hasUnknown && <tr className="border-t border-zinc-100"><th className="px-3 py-3 text-left font-medium text-zinc-600"><RowLabel icon={CircleHelp} label="Sin confirmar" title="Origen del registro desconocido" color="bg-zinc-100 text-zinc-500" /></th><td className="px-1 py-3 text-center">{marks(dayEvents, "entry", "unknown")}</td><td className="px-1 py-3 text-center">{marks(dayEvents, "exit", "unknown")}</td></tr>}
          </tbody>
        </table>}
        {!inactive && <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 px-3 py-3 text-xs text-zinc-600">
          {day?.random_entry_at != null && <span className="inline-flex items-center gap-1 text-amber-700"><Shuffle aria-hidden="true" className="h-2.5 w-2.5" />±{day.margin_seconds} s</span>}
          {!day && <span>Calendario sin sincronizar</span>}
          {day && !day.entry_time && <span>{day.label}</span>}
          {day && !day.random_entry_at && !entryJob && day.entry_time && dateKey(date) < dateKey(today) && <span>Sin cálculo histórico</span>}
          {dayJobs.map((job) => <span key={job.id} className={['failed', 'missed', 'uncertain'].includes(job.status) ? "text-rose-700" : ""}>{job.action === "entry" ? "Entrada" : "Salida"}: {statusLabels[job.status] ?? job.status}{job.planned_at && job.target_at !== job.planned_at ? ` · Reintento ${clock(job.target_at)}` : ""}{job.error_message ? ` · ${job.error_message}` : ""}</span>)}
        </footer>}
        </div>
      </article>;
    })}
  </div>;
}
