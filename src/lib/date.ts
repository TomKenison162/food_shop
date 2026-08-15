const LONDON_TZ = "Europe/London";

/** YYYY-MM-DD for a given instant, in Europe/London wall-clock time. */
export function londonDateString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LONDON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/** Current hour (0-23) in Europe/London wall-clock time. */
export function londonHour(date: Date = new Date()): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TZ,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return parseInt(value, 10) % 24;
}

/** 0=Sunday .. 6=Saturday, in Europe/London wall-clock time. */
export function londonDayOfWeek(date: Date = new Date()): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: LONDON_TZ, weekday: "short" }).format(
    date
  );
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
}

export function isLondonWeekend(date: Date = new Date()): boolean {
  const day = londonDayOfWeek(date);
  return day === 0 || day === 6;
}

export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 0=Sunday .. 6=Saturday for a YYYY-MM-DD string (calendar arithmetic, timezone-free). */
export function dayOfWeekForDateString(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday of the calendar week containing `dateStr` (ISO weeks: Mon-Sun). */
export function startOfWeek(dateStr: string): string {
  const dow = dayOfWeekForDateString(dateStr); // 0=Sun
  const daysSinceMonday = (dow + 6) % 7; // Mon->0, Sun->6
  return addDaysToDateString(dateStr, -daysSinceMonday);
}
