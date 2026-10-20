export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatterCache.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, value);
  }
  return value;
}

export function localParts(epochMs: number, timeZone: string): LocalDateParts {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDate(epochMs: number, timeZone: string) {
  const parts = localParts(epochMs, timeZone);
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(2, "0")}/${parts.year}`;
}

export function localClock(epochMs: number, timeZone: string) {
  const parts = localParts(epochMs, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;
}

export function weekdayForLocalDate(parts: Pick<LocalDateParts, "year" | "month" | "day">) {
  return (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() + 6) % 7;
}

function comparableUtc(parts: LocalDateParts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

export function zonedDateTimeToEpoch(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  time: string,
  timeZone: string,
) {
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const desired: LocalDateParts = { ...date, hour, minute, second };
  const desiredUtc = comparableUtc(desired);
  let candidate = desiredUtc;
  for (let pass = 0; pass < 3; pass++) {
    const observed = localParts(candidate, timeZone);
    candidate += desiredUtc - comparableUtc(observed);
  }
  return candidate;
}

export function addRandomMargin(epochMs: number, marginSeconds: number) {
  if (marginSeconds <= 0) return epochMs;
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const offset = Number(bytes[0] % (marginSeconds * 2 + 1)) - marginSeconds;
  return epochMs + offset * 1000;
}

export function configuredPunchPlan(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  timeZone: string,
  schedule: { enabled: number; entry_time: string; exit_time: string } | null | undefined,
  marginSeconds: number,
  calendar: { entry_time: string | null; exit_time: string | null; plan_key?: string | null; random_entry_at: number | null; random_exit_at: number | null } | null | undefined,
) {
  if (!schedule?.enabled || (calendar && (!calendar.entry_time || !calendar.exit_time))) return null;
  const key = JSON.stringify([schedule.entry_time, schedule.exit_time, marginSeconds, timeZone]);
  if (calendar?.plan_key === key && calendar.random_entry_at !== null && calendar.random_exit_at !== null) {
    return { key, entryAt: calendar.random_entry_at, exitAt: calendar.random_exit_at };
  }
  const entry = zonedDateTimeToEpoch(date, schedule.entry_time, timeZone);
  let exit = zonedDateTimeToEpoch(date, schedule.exit_time, timeZone);
  if (exit <= entry) exit += 24 * 60 * 60 * 1000;
  const margin = Math.min(marginSeconds, Math.floor((exit - entry - 1000) / 2000));
  return { key, entryAt: addRandomMargin(entry, margin), exitAt: addRandomMargin(exit, margin) };
}
