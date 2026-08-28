import { DateTime } from "luxon";
import type { Knex } from "knex";
import { db } from "../db/index.js";
import { addDays, addMonths, dayOfWeek, diffDays, localToday, maxDate, type DateStr } from "./dateMath.js";

/** "Today" as a calendar date in the campaign's own IANA timezone — see dateMath.ts's localToday() for why this matters. */

export const WEIGHT_LABELS = ["No", "Maybe", "If Needed", "Yes"] as const; // index == weight (0..3)

export interface CampaignCadence {
  id: string;
  start_date: DateStr;
  interval_weeks: number;
  sessions_per_interval: number;
  blackout_days_after_lock: number;
  min_players_required: number;
  /** Extra weight (+/-) applied only to the DM's own contribution for a raw "Maybe" (weight 1) response. Default 0. */
  dm_maybe_modifier: number;
  /** Extra weight (+/-) applied only to the DM's own contribution for a raw "If Needed" (weight 2) response. Default 0. */
  dm_if_needed_modifier: number;
  /** Deducted per active joining-late/dropping-early flag, floored at 0 overall. Default 0.5. */
  late_early_penalty: number;
}

export interface CandidateDate {
  date: DateStr;
  score: number;
  isDmAvailable: boolean;
  isAboveMinPlayers: boolean;
  breakdown: Array<{ discordId: string; weight: number; joiningLate: boolean; droppingEarly: boolean; excluded: boolean }>;
}

export interface BlockedDate {
  date: DateStr;
  reason: "block_full" | "block_skipped" | "blackout";
}

/** Inclusive block index containing `date`, relative to the campaign's anchor. */
export function blockIndexOf(campaign: Pick<CampaignCadence, "start_date" | "interval_weeks">, date: DateStr): number {
  const blockLengthDays = campaign.interval_weeks * 7;
  return Math.floor(diffDays(campaign.start_date, date) / blockLengthDays);
}

export function blockRange(campaign: Pick<CampaignCadence, "start_date" | "interval_weeks">, blockIndex: number): { start: DateStr; end: DateStr } {
  const blockLengthDays = campaign.interval_weeks * 7;
  const start = addDays(campaign.start_date, blockIndex * blockLengthDays);
  const end = addDays(start, blockLengthDays); // exclusive
  return { start, end };
}

/**
 * Every campaign member's raw response weight (0-3) for one specific date —
 * used to snapshot "who's actually expected to attend" at the moment a
 * session gets locked (or rescheduled to a new date), so that becomes the
 * attendance record instead of a blind "everyone showed up" default.
 * Independent of scoring exclusion — attendance and scoring are different
 * concerns, so this includes every member regardless of
 * excluded_from_scoring. Accepts an optional transaction so a caller
 * already inside one reads a fully consistent snapshot.
 */
export async function getMemberWeightsForDate(campaignId: string, date: DateStr, trx: Knex = db()): Promise<Map<string, number>> {
  const members: Array<{ discord_id: string }> = await trx("campaign_members").where({ campaign_id: campaignId });
  const defaultsRows: Array<{ discord_id: string; day_of_week: number; weight: number }> = await trx(
    "default_availability"
  ).where({ campaign_id: campaignId });
  const specificRows: Array<{ discord_id: string; weight: number }> = await trx("specific_availability").where({
    campaign_id: campaignId,
    date_utc: date,
  });

  const defaultsByMember = new Map<string, Map<number, number>>();
  for (const row of defaultsRows) {
    if (!defaultsByMember.has(row.discord_id)) defaultsByMember.set(row.discord_id, new Map());
    defaultsByMember.get(row.discord_id)!.set(row.day_of_week, row.weight);
  }
  const specificByMember = new Map<string, number>();
  for (const row of specificRows) specificByMember.set(row.discord_id, row.weight);

  const dow = dayOfWeek(date);
  const result = new Map<string, number>();
  for (const m of members) {
    const override = specificByMember.get(m.discord_id);
    result.set(m.discord_id, override !== undefined ? override : (defaultsByMember.get(m.discord_id)?.get(dow) ?? 0));
  }
  return result;
}

/**
 * Computes weighted, DM-veto-aware scores for every open candidate date in
 * the campaign's scheduling window, and separately reports dates that were
 * excluded and why (full block, skipped block, or post-lock blackout).
 */
export async function getCandidateDates(
  campaignId: string,
  windowMonths: number
): Promise<{ candidates: CandidateDate[]; blocked: BlockedDate[] }> {
  const campaign = await db()("campaigns").where({ id: campaignId }).first();
  if (!campaign) throw new Error("campaign_not_found");

  const members: Array<{ discord_id: string; role: "DM" | "Player"; excluded_from_scoring: boolean }> = await db()(
    "campaign_members"
  ).where({
    campaign_id: campaignId,
  });
  const dmIds = members.filter((m) => m.role === "DM").map((m) => m.discord_id);
  const memberIds = members.map((m) => m.discord_id);
  const excludedIds = new Set(members.filter((m) => m.excluded_from_scoring).map((m) => m.discord_id));
  // "Ignore their values entirely" — excluded members don't count toward the
  // score sum, don't factor into the DM veto, and don't count toward the
  // min-players headcount, even if they happen to be the DM.
  const scoringMemberIds = memberIds.filter((id) => !excludedIds.has(id));
  const activeDmIds = dmIds.filter((id) => !excludedIds.has(id));
  const activePlayerIds = members
    .filter((m) => m.role === "Player" && !excludedIds.has(m.discord_id))
    .map((m) => m.discord_id);

  const defaultsRows: Array<{ discord_id: string; day_of_week: number; weight: number }> = await db()(
    "default_availability"
  ).where({ campaign_id: campaignId });
  const specificRows: Array<{
    discord_id: string;
    date_utc: DateStr;
    weight: number;
    joining_late: boolean;
    dropping_early: boolean;
  }> = await db()("specific_availability").where({ campaign_id: campaignId });

  const defaultsByMember = new Map<string, Map<number, number>>();
  for (const row of defaultsRows) {
    if (!defaultsByMember.has(row.discord_id)) defaultsByMember.set(row.discord_id, new Map());
    defaultsByMember.get(row.discord_id)!.set(row.day_of_week, row.weight);
  }
  const specificByMember = new Map<string, Map<DateStr, { weight: number; joiningLate: boolean; droppingEarly: boolean }>>();
  for (const row of specificRows) {
    if (!specificByMember.has(row.discord_id)) specificByMember.set(row.discord_id, new Map());
    specificByMember
      .get(row.discord_id)!
      .set(row.date_utc, { weight: row.weight, joiningLate: !!row.joining_late, droppingEarly: !!row.dropping_early });
  }

  /** Raw weight (0-3), ignoring late/early flags — used for the DM-veto check and pip display. */
  function weightFor(discordId: string, date: DateStr): number {
    const override = specificByMember.get(discordId)?.get(date);
    if (override !== undefined) return override.weight;
    return defaultsByMember.get(discordId)?.get(dayOfWeek(date)) ?? 0;
  }

  function flagsFor(discordId: string, date: DateStr): { joiningLate: boolean; droppingEarly: boolean } {
    const override = specificByMember.get(discordId)?.get(date);
    return { joiningLate: override?.joiningLate ?? false, droppingEarly: override?.droppingEarly ?? false };
  }

  // Defensive Number() coercion: FLOAT columns come back as JS numbers from
  // mysql2 already, but this keeps the math safe even if that ever changes.
  const lateEarlyPenalty = Number(campaign.late_early_penalty ?? 0.5);
  const dmMaybeModifier = Number(campaign.dm_maybe_modifier ?? 0);
  const dmIfNeededModifier = Number(campaign.dm_if_needed_modifier ?? 0);

  /**
   * Actual score contribution: raw weight, plus the DM-only Maybe/If-Needed
   * modifier when applicable, minus the configured late/early penalty per
   * active flag — floored at 0 overall.
   */
  function contributionFor(discordId: string, date: DateStr): number {
    const weight = weightFor(discordId, date);
    const { joiningLate, droppingEarly } = flagsFor(discordId, date);
    const isDm = dmIds.includes(discordId);
    const dmAdjust = isDm && weight === 1 ? dmMaybeModifier : isDm && weight === 2 ? dmIfNeededModifier : 0;
    const deduction = (joiningLate ? lateEarlyPenalty : 0) + (droppingEarly ? lateEarlyPenalty : 0);
    return Math.max(0, weight + dmAdjust - deduction);
  }

  // Existing sessions drive block-fullness, skipped blocks, and blackout.
  const sessions: Array<{
    scheduled_start_utc: string;
    status: "scheduled" | "completed" | "skipped" | "cancelled";
  }> = await db()("sessions").where({ campaign_id: campaignId }).whereNot({ status: "cancelled" });

  const sessionDateOf = (s: { scheduled_start_utc: string }): DateStr => s.scheduled_start_utc.slice(0, 10);

  const skippedBlockIndices = new Set(
    sessions.filter((s) => s.status === "skipped").map((s) => blockIndexOf(campaign, sessionDateOf(s)))
  );
  const activeSessionsByBlock = new Map<number, number>();
  for (const s of sessions) {
    if (s.status !== "scheduled" && s.status !== "completed") continue;
    const idx = blockIndexOf(campaign, sessionDateOf(s));
    activeSessionsByBlock.set(idx, (activeSessionsByBlock.get(idx) ?? 0) + 1);
  }
  const lockedDates = sessions
    .filter((s) => s.status === "scheduled" || s.status === "completed")
    .map((s) => sessionDateOf(s));

  const today = localToday(campaign.timezone);
  const windowStart = maxDate(today, campaign.start_date);
  const windowEnd = addMonths(today, windowMonths);

  const candidates: CandidateDate[] = [];
  const blocked: BlockedDate[] = [];

  for (let date = windowStart; date < windowEnd; date = addDays(date, 1)) {
    const blockIdx = blockIndexOf(campaign, date);

    if (skippedBlockIndices.has(blockIdx)) {
      blocked.push({ date, reason: "block_skipped" });
      continue;
    }
    if ((activeSessionsByBlock.get(blockIdx) ?? 0) >= campaign.sessions_per_interval) {
      blocked.push({ date, reason: "block_full" });
      continue;
    }
    const withinBlackout = lockedDates.some((lockedDate) => {
      const gap = diffDays(lockedDate, date);
      return gap > 0 && gap <= campaign.blackout_days_after_lock;
    });
    if (withinBlackout) {
      blocked.push({ date, reason: "blackout" });
      continue;
    }

    const breakdown = memberIds.map((id) => ({
      discordId: id,
      weight: weightFor(id, date),
      ...flagsFor(id, date),
      excluded: excludedIds.has(id),
    }));
    // DM veto is based on raw weight, not the flag-adjusted contribution — a
    // DM joining late is still available for (most of) the session, so they
    // shouldn't zero out the whole date the way an outright "No" does.
    const isDmAvailable = activeDmIds.length === 0 || activeDmIds.every((id) => weightFor(id, date) > 0);
    const availablePlayerCount = activePlayerIds.filter((id) => weightFor(id, date) > 0).length;
    const isAboveMinPlayers = availablePlayerCount >= campaign.min_players_required;
    const score =
      isDmAvailable && isAboveMinPlayers ? scoringMemberIds.reduce((sum, id) => sum + contributionFor(id, date), 0) : 0;

    candidates.push({ date, score, isDmAvailable, isAboveMinPlayers, breakdown });
  }

  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.date.localeCompare(b.date)));

  return { candidates, blocked };
}
