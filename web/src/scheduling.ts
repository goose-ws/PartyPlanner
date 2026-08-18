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

/** The subset of a campaign's settings that scoring needs — Campaign itself satisfies this. */
export interface ScoringCampaign {
  min_players_required: number;
  dm_maybe_modifier: number;
  dm_if_needed_modifier: number;
  late_early_penalty: number;
}

/**
 * Actual score contribution: raw weight, plus the DM-only Maybe/If-Needed
 * modifier when applicable, minus the campaign's configured late/early
 * penalty per active flag — floored at 0 overall. Mirrors the backend exactly.
 */
export function contributionFor(
  maps: AvailabilityMaps,
  discordId: string,
  date: DateStr,
  isDm: boolean,
  campaign: ScoringCampaign
): number {
  const weight = weightFor(maps, discordId, date);
  const { joiningLate, droppingEarly } = flagsFor(maps, discordId, date);
  const dmAdjust = isDm && weight === 1 ? campaign.dm_maybe_modifier : isDm && weight === 2 ? campaign.dm_if_needed_modifier : 0;
  const penalty = campaign.late_early_penalty;
  const deduction = (joiningLate ? penalty : 0) + (droppingEarly ? penalty : 0);
  return Math.max(0, weight + dmAdjust - deduction);
}

/**
 * Computes the same score/DM-veto/min-players logic as the backend candidate
 * engine, but for ANY date — including already-locked ones, which the
 * candidates list deliberately excludes since it only covers open (unlocked)
 * dates. Also splits the total into the Player-only sum ("P") and the
 * DM-only sum ("DM") for display.
 */
export function computeDayScore(
  maps: AvailabilityMaps,
  members: AvailabilityAll["members"],
  date: DateStr,
  campaign: ScoringCampaign
): { score: number; playerScore: number; dmScore: number; isDmAvailable: boolean; isAboveMinPlayers: boolean } {
  // "Ignore their values entirely" — excluded members don't count toward the
  // score sum, the DM veto, or the min-players headcount below.
  const activeDmIds = members.filter((m) => m.role === "DM" && !m.excludedFromScoring).map((m) => m.discordId);
  const isDmAvailable = activeDmIds.length === 0 || activeDmIds.every((id) => weightFor(maps, id, date) > 0);

  const activePlayerIds = members.filter((m) => m.role === "Player" && !m.excludedFromScoring).map((m) => m.discordId);
  const availablePlayerCount = activePlayerIds.filter((id) => weightFor(maps, id, date) > 0).length;
  const isAboveMinPlayers = availablePlayerCount >= campaign.min_players_required;

  const scoringMembers = members.filter((m) => !m.excludedFromScoring);
  const veto = !(isDmAvailable && isAboveMinPlayers);
  const playerScore = veto
    ? 0
    : scoringMembers
        .filter((m) => m.role === "Player")
        .reduce((sum, m) => sum + contributionFor(maps, m.discordId, date, false, campaign), 0);
  const dmScore = veto
    ? 0
    : scoringMembers
        .filter((m) => m.role === "DM")
        .reduce((sum, m) => sum + contributionFor(maps, m.discordId, date, true, campaign), 0);
  const score = playerScore + dmScore;
  return { score, playerScore, dmScore, isDmAvailable, isAboveMinPlayers };
}
