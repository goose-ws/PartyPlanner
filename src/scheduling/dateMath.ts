/** All dates in this module are plain 'YYYY-MM-DD' strings — no timezone, no Date objects. */
export type DateStr = string;

function toEpochDay(date: DateStr): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

function fromEpochDay(epochDay: number): DateStr {
  const ms = epochDay * 86_400_000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(date: DateStr, days: number): DateStr {
  return fromEpochDay(toEpochDay(date) + days);
}

export function diffDays(a: DateStr, b: DateStr): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** 0 (Sunday) .. 6 (Saturday), matching MariaDB's DAYOFWEEK-1 / JS Date.getUTCDay() convention. */
export function dayOfWeek(date: DateStr): number {
  // epoch day 0 = 1970-01-01, which was a Thursday (day 4).
  return ((toEpochDay(date) + 4) % 7 + 7) % 7;
}

export function todayUtc(): DateStr {
  return new Date().toISOString().slice(0, 10);
}

export function isBefore(a: DateStr, b: DateStr): boolean {
  return a < b; // safe lexicographic comparison for zero-padded YYYY-MM-DD
}

export function maxDate(a: DateStr, b: DateStr): DateStr {
  return a > b ? a : b;
}

export function addMonths(date: DateStr, months: number): DateStr {
  const [y, m, d] = date.split("-").map(Number);
  const total = m! - 1 + months;
  const newY = y! + Math.floor(total / 12);
  const newM = ((total % 12) + 12) % 12;
  // Clamp day to avoid overflow (e.g. Jan 31 + 1mo shouldn't become March).
  const daysInNewMonth = new Date(Date.UTC(newY, newM + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d!, daysInNewMonth);
  return `${newY}-${String(newM + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}
