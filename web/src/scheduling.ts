import type { AvailabilityAll } from "./api";
import { dayOfWeek, type DateStr } from "./dateMath";

interface SpecificEntry {
  weight: number;
  joiningLate: boolean;
  droppingEarly: boolean;
}

export interface AvailabilityMaps {
  defaultsByMember: Map<string, Map<number, number>>;
  specificByMember: Map<string, Map<DateStr, SpecificEntry>>;
}

export function buildAvailabilityMaps(data: AvailabilityAll): AvailabilityMaps {
  const defaultsByMember = new Map<string, Map<number, number>>();
  for (const d of data.defaults) {
    if (!defaultsByMember.has(d.discordId)) defaultsByMember.set(d.discordId, new Map());
    defaultsByMember.get(d.discordId)!.set(d.dayOfWeek, d.weight);
  }
  const specificByMember = new Map<string, Map<DateStr, SpecificEntry>>();
  for (const s of data.specific) {
    if (!specificByMember.has(s.discordId)) specificByMember.set(s.discordId, new Map());
    specificByMember.get(s.discordId)!.set(s.date, { weight: s.weight, joiningLate: s.joiningLate, droppingEarly: s.droppingEarly });
  }
  return { defaultsByMember, specificByMember };
}

/** Raw weight (0-3), ignoring late/early flags — for pip display and the DM-veto check. */
export function weightFor(maps: AvailabilityMaps, discordId: string, date: DateStr): number {
  const override = maps.specificByMember.get(discordId)?.get(date);
  if (override !== undefined) return override.weight;
  return maps.defaultsByMember.get(discordId)?.get(dayOfWeek(date)) ?? 0;
}

export function flagsFor(maps: AvailabilityMaps, discordId: string, date: DateStr): { joiningLate: boolean; droppingEarly: boolean } {
  const override = maps.specificByMember.get(discordId)?.get(date);
  return { joiningLate: override?.joiningLate ?? false, droppingEarly: override?.droppingEarly ?? false };
}

/** Actual score contribution: raw weight minus 0.5 per active flag, floored at 0 — mirrors the backend exactly. */
export function contributionFor(maps: AvailabilityMaps, discordId: string, date: DateStr): number {
  const weight = weightFor(maps, discordId, date);
  const { joiningLate, droppingEarly } = flagsFor(maps, discordId, date);
  const deduction = (joiningLate ? 0.5 : 0) + (droppingEarly ? 0.5 : 0);
  return Math.max(0, weight - deduction);
}

/**
 * Computes the same score/DM-veto/min-players logic as the backend candidate
 * engine, but for ANY date — including already-locked ones, which the
 * candidates list deliberately excludes since it only covers open (unlocked)
 * dates.
 */
export function computeDayScore(
  maps: AvailabilityMaps,
  members: AvailabilityAll["members"],
  date: DateStr,
  minPlayersRequired = 0
): { score: number; isDmAvailable: boolean; isAboveMinPlayers: boolean } {
  // "Ignore their values entirely" — excluded members don't count toward the
  // score sum, the DM veto, or the min-players headcount below.
  const activeDmIds = members.filter((m) => m.role === "DM" && !m.excludedFromScoring).map((m) => m.discordId);
  const isDmAvailable = activeDmIds.length === 0 || activeDmIds.every((id) => weightFor(maps, id, date) > 0);

  const activePlayerIds = members.filter((m) => m.role === "Player" && !m.excludedFromScoring).map((m) => m.discordId);
  const availablePlayerCount = activePlayerIds.filter((id) => weightFor(maps, id, date) > 0).length;
  const isAboveMinPlayers = availablePlayerCount >= minPlayersRequired;

  const score =
    isDmAvailable && isAboveMinPlayers
      ? members
          .filter((m) => !m.excludedFromScoring)
          .reduce((sum, m) => sum + contributionFor(maps, m.discordId, date), 0)
      : 0;
  return { score, isDmAvailable, isAboveMinPlayers };
}
