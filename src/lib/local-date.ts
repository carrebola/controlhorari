/** Timenet local dates use DD/MM/YYYY. */
export const dateKey = (value: string) => value.split("/").reverse().join("-");

/** Shift a Timenet local date by whole calendar days. */
export function shiftLocalDate(value: string, delta: number) {
  const [day, month, year] = value.split("/").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + delta));
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" }).format(next);
}
