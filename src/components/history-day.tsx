import { CalendarClock, Hand, Bot } from "lucide-react";

export type MarkSource = "manual" | "automatic" | "unknown";
type Interval = { entry: string; exit: string };

export function HistoryDay({ cells, planned, kind, calculated, sources = [] }: {
  cells: string[];
  planned?: Interval[];
  kind?: string;
  calculated?: Interval;
  sources?: MarkSource[];
}) {
  const scheduledText = /\s+a\s+/.test(cells[1]);
  const times = scheduledText ? [] : cells[1].match(/\d{1,2}:\d{2}(?::\d{2})?/g) || [];
  const plannedText = planned?.length ? planned.map((slot) => `${slot.entry} – ${slot.exit}`).join(" · ") : scheduledText ? cells[1] : kind === "holiday" ? "Festivo" : kind === "vacation" ? "Vacaciones" : kind === "undefined" ? "Jornada no definida" : "No disponible";
  const automaticMarks = times.some((_, index) => sources[index] === "automatic");
  const unknownMarks = times.some((_, index) => !sources[index] || sources[index] === "unknown");

  function markedPairs(automatic: boolean) {
    const pairs: string[] = [];
    for (let index = 0; index < times.length; index += 2) {
      const belongs = (position: number) => automatic ? sources[position] === "automatic" : sources[position] !== "automatic";
      const entry = belongs(index) ? times[index] : undefined;
      const exit = times[index + 1] && belongs(index + 1) ? times[index + 1] : undefined;
      if (entry || exit) pairs.push(`${entry || "—"} – ${exit || "—"}`);
    }
    return pairs.join(" · ");
  }

  return <article className="rounded-md border border-zinc-200 bg-white p-4">
    <h3 className="font-semibold tabular-nums">{cells[0]}</h3>
    <div className="mt-4 space-y-3">
      <div className="flex items-start gap-3 text-amber-800">
        <CalendarClock aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0"><p className="text-xs font-medium">Previsto</p><p className="mt-1 break-words font-semibold tabular-nums">{plannedText}</p></div>
      </div>
      <div className={`flex items-start gap-3 ${unknownMarks ? "text-zinc-600" : times.length && markedPairs(false) ? "text-emerald-800" : "text-zinc-400"}`}>
        <Hand aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0"><p className="text-xs font-medium">{unknownMarks ? "Marcado · origen sin identificar" : "Manual"}</p><p className="mt-1 break-words font-semibold tabular-nums">{markedPairs(false) || "— – —"}</p></div>
      </div>
      <div className={`flex items-start gap-3 ${automaticMarks ? "text-sky-800" : calculated ? "text-sky-700" : "text-zinc-400"}`}>
        <Bot aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0"><p className="text-xs font-medium">{automaticMarks ? "Automático · marcado" : "Automático · previsto"}</p><p className="mt-1 break-words font-semibold tabular-nums">{automaticMarks ? markedPairs(true) : calculated ? `${calculated.entry} – ${calculated.exit}` : "— – —"}</p></div>
      </div>
    </div>
    <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-zinc-100 pt-3 text-xs">
      <div><dt className="text-zinc-500">Previstas</dt><dd className="mt-1 font-medium text-amber-800">{cells[2] || "—"}</dd></div>
      <div><dt className="text-zinc-500">Trabajadas</dt><dd className="mt-1 font-medium text-emerald-800">{cells[3] || "—"}</dd></div>
      <div><dt className="text-zinc-500">Diferencia</dt><dd className={`mt-1 font-medium ${cells[4]?.startsWith("-") ? "text-red-700" : "text-zinc-700"}`}>{cells[4] || "—"}</dd></div>
    </dl>
  </article>;
}
