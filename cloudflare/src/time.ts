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

/** Automatic entry fires this many seconds before the chosen base start. */
export const ENTRY_LEAD_SECONDS = 10 * 60;
/** Automatic exit fires this many seconds after the chosen base end. */
export const EXIT_LAG_SECONDS = 10 * 60;

type PunchPlanKey = {
  month: string;
  baseEntry: string;
  baseExit: string;
  lead: number;
  lag: number;
  margin: number;
  timeZone: string;
};

export function addRandomMargin(epochMs: number, marginSeconds: number) {
  if (marginSeconds <= 0) return epochMs;
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const offset = Number(bytes[0] % (marginSeconds * 2 + 1)) - marginSeconds;
  return epochMs + offset * 1000;
}

function planMonth(date: Pick<LocalDateParts, "year" | "month">) {
  return `${date.year}-${String(date.month).padStart(2, "0")}`;
}

function parsePlanKey(value: string | null | undefined): PunchPlanKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PunchPlanKey>;
    if (
      typeof parsed.month === "string"
      && typeof parsed.baseEntry === "string"
      && typeof parsed.baseExit === "string"
      && typeof parsed.lead === "number"
      && typeof parsed.lag === "number"
      && typeof parsed.margin === "number"
      && typeof parsed.timeZone === "string"
    ) return parsed as PunchPlanKey;
  } catch { /* Legacy plan keys are discarded and regenerated. */ }
  return null;
}

function settingsMatch(saved: PunchPlanKey, month: string, marginSeconds: number, timeZone: string) {
  return saved.month === month
    && saved.lead === ENTRY_LEAD_SECONDS
    && saved.lag === EXIT_LAG_SECONDS
    && saved.margin === marginSeconds
    && saved.timeZone === timeZone;
}

export function configuredPunchPlan(
  date: Pick<LocalDateParts, "year" | "month" | "day">,
  timeZone: string,
  schedule: { enabled: number; entry_time: string; exit_time: string } | null | undefined,
  marginSeconds: number,
  calendar: { entry_time: string | null; exit_time: string | null; plan_key?: string | null; random_entry_at: number | null; random_exit_at: number | null } | null | undefined,
) {
  if (!schedule?.enabled) return null;
  // Timenet calendar without times = non-working day; do not invent a plan.
  if (calendar && (!calendar.entry_time || !calendar.exit_time)) return null;

  const month = planMonth(date);
  const savedKey = parsePlanKey(calendar?.plan_key);
  // Reuse the already saved punch times for the month (margen aleatorio estable).
  if (
    savedKey
    && calendar?.random_entry_at != null
    && calendar.random_exit_at != null
    && settingsMatch(savedKey, month, marginSeconds, timeZone)
  ) {
    return { key: calendar.plan_key!, entryAt: calendar.random_entry_at, exitAt: calendar.random_exit_at };
  }

  // No saved plan (or new month / settings): base on Timenet previsto, else weekly schedule.
  const baseEntry = calendar?.entry_time ?? schedule.entry_time;
  const baseExit = calendar?.exit_time ?? schedule.exit_time;
  const keyObject: PunchPlanKey = {
    month,
    baseEntry,
    baseExit,
    lead: ENTRY_LEAD_SECONDS,
    lag: EXIT_LAG_SECONDS,
    margin: marginSeconds,
    timeZone,
  };
  const key = JSON.stringify(keyObject);
  const entry = zonedDateTimeToEpoch(date, baseEntry, timeZone) - ENTRY_LEAD_SECONDS * 1000;
  let exit = zonedDateTimeToEpoch(date, baseExit, timeZone) + EXIT_LAG_SECONDS * 1000;
  if (exit <= entry) exit += 24 * 60 * 60 * 1000;
  const margin = Math.min(marginSeconds, Math.floor((exit - entry - 1000) / 2000));
  return { key, entryAt: addRandomMargin(entry, margin), exitAt: addRandomMargin(exit, margin) };
}
