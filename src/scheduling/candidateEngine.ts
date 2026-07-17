import { db } from "../db/index.js";
import { addDays, addMonths, dayOfWeek, diffDays, maxDate, todayUtc, type DateStr } from "./dateMath.js";

export const WEIGHT_LABELS = ["No", "Maybe", "If Needed", "Yes"] as const; // index == weight (0..3)

export interface CampaignCadence {
  id: string;
  start_date: DateStr;
  interval_weeks: number;
  sessions_per_interval: number;
  blackout_days_after_lock: number;
}

export interface CandidateDate {
  date: DateStr;
  score: number;
  isDmAvailable: boolean;
  breakdown: Array<{ discordId: string; weight: number }>;
}

export interface BlockedDate {
  date: DateStr;
  reason: "block_full" | "block_skipped" | "blackout";
}

/** Inclusive block index containing `date`, relative to the campaign's anchor. */
function blockIndexOf(campaign: CampaignCadence, date: DateStr): number {
  const blockLengthDays = campaign.interval_weeks * 7;
  return Math.floor(diffDays(campaign.start_date, date) / blockLengthDays);
}

function blockRange(campaign: CampaignCadence, blockIndex: number): { start: DateStr; end: DateStr } {
  const blockLengthDays = campaign.interval_weeks * 7;
  const start = addDays(campaign.start_date, blockIndex * blockLengthDays);
  const end = addDays(start, blockLengthDays); // exclusive
  return { start, end };
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

  const members: Array<{ discord_id: string; role: "DM" | "Player" }> = await db()("campaign_members").where({
    campaign_id: campaignId,
  });
  const dmIds = members.filter((m) => m.role === "DM").map((m) => m.discord_id);
  const memberIds = members.map((m) => m.discord_id);

  const defaultsRows: Array<{ discord_id: string; day_of_week: number; weight: number }> = await db()(
    "default_availability"
  ).where({ campaign_id: campaignId });
  const specificRows: Array<{ discord_id: string; date_utc: DateStr; weight: number }> = await db()(
    "specific_availability"
  ).where({ campaign_id: campaignId });

  const defaultsByMember = new Map<string, Map<number, number>>();
  for (const row of defaultsRows) {
    if (!defaultsByMember.has(row.discord_id)) defaultsByMember.set(row.discord_id, new Map());
    defaultsByMember.get(row.discord_id)!.set(row.day_of_week, row.weight);
  }
  const specificByMember = new Map<string, Map<DateStr, number>>();
  for (const row of specificRows) {
    if (!specificByMember.has(row.discord_id)) specificByMember.set(row.discord_id, new Map());
    specificByMember.get(row.discord_id)!.set(row.date_utc, row.weight);
  }

  function weightFor(discordId: string, date: DateStr): number {
    const override = specificByMember.get(discordId)?.get(date);
    if (override !== undefined) return override;
    return defaultsByMember.get(discordId)?.get(dayOfWeek(date)) ?? 0;
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

  const windowStart = maxDate(todayUtc(), campaign.start_date);
  const windowEnd = addMonths(todayUtc(), windowMonths);

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

    const breakdown = memberIds.map((id) => ({ discordId: id, weight: weightFor(id, date) }));
    const isDmAvailable = dmIds.length === 0 || dmIds.every((id) => weightFor(id, date) > 0);
    const score = isDmAvailable ? breakdown.reduce((sum, b) => sum + b.weight, 0) : 0;

    candidates.push({ date, score, isDmAvailable, breakdown });
  }

  candidates.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.date.localeCompare(b.date)));

  return { candidates, blocked };
}
