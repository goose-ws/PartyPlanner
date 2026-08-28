export type DateStr = string; // 'YYYY-MM-DD'

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDateStr(y: number, m: number, d: number): DateStr {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function toEpochDay(date: DateStr): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/** Whole days from a to b (b - a). Mirrors the backend's diffDays() exactly. */
export function diffDays(a: DateStr, b: DateStr): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** Inclusive block index containing `date`, relative to the campaign's anchor. Mirrors the backend's blockIndexOf() exactly. */
export function blockIndexOf(startDate: DateStr, intervalWeeks: number, date: DateStr): number {
  const blockLengthDays = intervalWeeks * 7;
  return Math.floor(diffDays(startDate, date) / blockLengthDays);
}

export function todayUtc(): DateStr {
  const d = new Date();
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  return `${year}-${month}-${day}`;
}

/** 0 (Sunday) .. 6 (Saturday) — matches the backend's dayOfWeek() exactly. */
export function dayOfWeek(date: DateStr): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function addMonthsToYearMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = month + delta;
  const newYear = year + Math.floor(total / 12);
  const newMonth = ((total % 12) + 12) % 12;
  return { year: newYear, month: newMonth };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month]} ${year}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export { WEEKDAY_SHORT };

/** Generates a full 6-row month grid (42 cells) including leading/trailing days from adjacent months. */
export function buildMonthGrid(year: number, month: number): Array<{ date: DateStr; inMonth: boolean }> {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startWeekday = firstOfMonth.getUTCDay();
  const totalDaysThisMonth = daysInMonth(year, month);

  const cells: Array<{ date: DateStr; inMonth: boolean }> = [];

  const { year: prevYear, month: prevMonth } = addMonthsToYearMonth(year, month, -1);
  const daysInPrevMonth = daysInMonth(prevYear, prevMonth);
  for (let i = 0; i < startWeekday; i++) {
    const d = daysInPrevMonth - startWeekday + i + 1;
    cells.push({ date: toDateStr(prevYear, prevMonth + 1, d), inMonth: false });
  }

  for (let d = 1; d <= totalDaysThisMonth; d++) {
    cells.push({ date: toDateStr(year, month + 1, d), inMonth: true });
  }

  const { year: nextYear, month: nextMonth } = addMonthsToYearMonth(year, month, 1);
  let nextDay = 1;
  while (cells.length < 42) {
    cells.push({ date: toDateStr(nextYear, nextMonth + 1, nextDay), inMonth: false });
    nextDay++;
  }

  return cells;
}

export function formatDateHuman(date: DateStr): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Formats a MySQL DATETIME string (always a true UTC instant in this app) in the campaign's IANA timezone. */
export function formatInTimezone(mysqlDatetime: string, timezone: string): string {
  const utcIso = mysqlDatetime.replace(" ", "T") + "Z";
  return new Date(utcIso).toLocaleString(undefined, {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The session's actual local calendar date in the campaign's timezone —
 * NOT scheduled_start_utc.slice(0, 10), which is the UTC date and can
 * differ from the campaign's local date near midnight (e.g. an 8pm EDT
 * session is 00:00 UTC the *next* day). Use this anywhere a session needs
 * to be placed on, or matched against, a specific calendar cell — the
 * calendar grid, "view on calendar" links, session list dates, reschedule
 * defaults, etc. Mirrors the backend's localDateOf() in reminders.ts exactly.
 */
export function localDateOf(mysqlDatetimeUtc: string, timezone: string): DateStr {
  const instant = new Date(mysqlDatetimeUtc.replace(" ", "T") + "Z");
  // en-CA's default date format is YYYY-MM-DD, which happens to be exactly
  // what we want — no manual reassembly of the Intl parts needed.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
