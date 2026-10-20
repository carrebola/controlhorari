import type { JobAction } from "./types";

export interface TimenetDay {
  localDate: string;
  label: string;
  entryTime: string | null;
  exitTime: string | null;
}

export interface TimenetHistoryEvent {
  remoteId: string;
  localDate: string;
  action: JobAction;
  time: string;
}

const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

// The authenticated checks response has T = calendar label and C = actual
// punches. Reading rendered text mixes future calendar times with real punches.
export function parseTimenetHistory(payload: unknown): { days: TimenetDay[]; events: TimenetHistoryEvent[] } {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { C?: unknown }).C)) {
    throw new Error("El formato del historial de Timenet no es válido.");
  }
  const days: TimenetDay[] = [];
  const events: TimenetHistoryEvent[] = [];
  for (const value of (payload as { C: unknown[] }).C) {
    if (!value || typeof value !== "object") throw new Error("Día de Timenet no válido.");
    const day = value as Record<string, unknown>;
    if (typeof day.D !== "string" || !datePattern.test(day.D) || typeof day.T !== "string" || !Array.isArray(day.C)) {
      throw new Error("Faltan datos del calendario de Timenet.");
    }
    const ranges = Array.from(day.T.matchAll(/\b([0-2]?\d:[0-5]\d)\s+a\s+([0-2]?\d:[0-5]\d)\b/g));
    // Multiple shifts need their own plan; never silently collapse them into
    // one continuous automatic shift.
    const range = ranges.length === 1 ? ranges[0] : null;
    const entry = range?.[1].padStart(5, "0") ?? null;
    const exit = range?.[2].padStart(5, "0") ?? null;
    days.push({ localDate: day.D, label: day.T, entryTime: entry && timePattern.test(entry) ? entry : null, exitTime: exit && timePattern.test(exit) ? exit : null });
    for (const value of day.C) {
      if (!value || typeof value !== "object") throw new Error("Fichaje de Timenet no válido.");
      const mark = value as Record<string, unknown>;
      // T is the explicit direction (0 entry, 1 exit), never list parity.
      if (mark.T !== 0 && mark.T !== 1) throw new Error("Tipo de fichaje de Timenet no compatible.");
      if (typeof mark.H !== "string" || !timePattern.test(mark.H) || (typeof mark.I !== "number" && typeof mark.I !== "string")) {
        throw new Error("Hora o identificador de fichaje de Timenet no válido.");
      }
      events.push({ remoteId: String(mark.I), localDate: day.D, action: mark.T === 0 ? "entry" : "exit", time: mark.H });
    }
  }
  if (!days.length) throw new Error("Timenet no devolvió días; se conserva el historial anterior.");
  return { days, events };
}
