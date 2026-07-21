import type { AvailabilityAll } from "./api";
import { dayOfWeek, type DateStr } from "./dateMath";

export interface AvailabilityMaps {
  defaultsByMember: Map<string, Map<number, number>>;
  specificByMember: Map<string, Map<DateStr, number>>;
}

export function buildAvailabilityMaps(data: AvailabilityAll): AvailabilityMaps {
  const defaultsByMember = new Map<string, Map<number, number>>();
  for (const d of data.defaults) {
    if (!defaultsByMember.has(d.discordId)) defaultsByMember.set(d.discordId, new Map());
    defaultsByMember.get(d.discordId)!.set(d.dayOfWeek, d.weight);
  }
  const specificByMember = new Map<string, Map<DateStr, number>>();
  for (const s of data.specific) {
    if (!specificByMember.has(s.discordId)) specificByMember.set(s.discordId, new Map());
    specificByMember.get(s.discordId)!.set(s.date, s.weight);
  }
  return { defaultsByMember, specificByMember };
}

export function weightFor(maps: AvailabilityMaps, discordId: string, date: DateStr): number {
  const override = maps.specificByMember.get(discordId)?.get(date);
  if (override !== undefined) return override;
  return maps.defaultsByMember.get(discordId)?.get(dayOfWeek(date)) ?? 0;
}

/**
 * Computes the same score/DM-veto logic as the backend candidate engine,
 * but for ANY date — including already-locked ones, which the candidates
 * list deliberately excludes since it only covers open (unlocked) dates.
 */
export function computeDayScore(
  maps: AvailabilityMaps,
  members: AvailabilityAll["members"],
  date: DateStr
): { score: number; isDmAvailable: boolean } {
  const dmIds = members.filter((m) => m.role === "DM").map((m) => m.discordId);
  const isDmAvailable = dmIds.length === 0 || dmIds.every((id) => weightFor(maps, id, date) > 0);
  const score = isDmAvailable ? members.reduce((sum, m) => sum + weightFor(maps, m.discordId, date), 0) : 0;
  return { score, isDmAvailable };
}
