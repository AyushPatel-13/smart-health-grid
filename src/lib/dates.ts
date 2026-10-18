// Date helpers. Operational dates are calendar days in India Standard Time,
// represented as ISO "YYYY-MM-DD" strings so they survive serialisation
// between server, client and database unchanged.

export const APP_TIME_ZONE = "Asia/Kolkata";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (IST) of an instant, as YYYY-MM-DD. */
export function toISTDate(instant: Date | string | number = new Date()): string {
  return dayFormatter.format(new Date(instant));
}

export function todayIST(): string {
  return toISTDate(new Date());
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(day: string, n: number): string {
  const dt = parseDay(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(day: string): number {
  return parseDay(day).getUTCDay();
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function isValidDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const dt = parseDay(value);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === value;
}

export function hoursBetween(from: Date | string, to: Date | string = new Date()): number {
  return (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
}

/** Midnight-anchored instant for a calendar day in IST plus an hour offset. */
export function istInstant(day: string, hour = 9, minute = 0): string {
  const [y, m, d] = day.split("-").map(Number);
  // IST = UTC+05:30 (no DST)
  const utc = Date.UTC(y, m - 1, d, hour, minute) - 330 * 60_000;
  return new Date(utc).toISOString();
}
