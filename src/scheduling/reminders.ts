import { db } from "../db/index.js";
import { blockIndexOf, blockRange, type CampaignCadence } from "./candidateEngine.js";
import { addDays, diffDays, maxDate, todayUtc, type DateStr } from "./dateMath.js";
import { sendDiscordMessage } from "../discord/webhook.js";

const MAX_BLOCKS_TO_SCAN = 26; // ~1 year out at a 2-week cadence — safety bound, not a real limit

export interface ActiveBlock {
  index: number;
  start: DateStr;
  end: DateStr;
}

/** The earliest block, starting from today, that isn't skipped and hasn't already met its session quota. */
export async function getActiveBlock(campaignId: string): Promise<ActiveBlock | null> {
  const campaign: CampaignCadence & { sessions_per_interval: number } = await db()("campaigns")
    .where({ id: campaignId })
    .first();
  if (!campaign) return null;

  const sessions: Array<{ scheduled_start_utc: string; status: string }> = await db()("sessions")
    .where({ campaign_id: campaignId })
    .whereNot({ status: "cancelled" });

  const sessionDateOf = (s: { scheduled_start_utc: string }): DateStr => s.scheduled_start_utc.slice(0, 10);
  const skippedBlocks = new Set(sessions.filter((s) => s.status === "skipped").map((s) => blockIndexOf(campaign, sessionDateOf(s))));
  const occupancy = new Map<number, number>();
  for (const s of sessions) {
    if (s.status !== "scheduled" && s.status !== "completed") continue;
    const idx = blockIndexOf(campaign, sessionDateOf(s));
    occupancy.set(idx, (occupancy.get(idx) ?? 0) + 1);
  }

  const startIdx = blockIndexOf(campaign, maxDate(todayUtc(), campaign.start_date));
  for (let i = startIdx; i < startIdx + MAX_BLOCKS_TO_SCAN; i++) {
    if (skippedBlocks.has(i)) continue;
    if ((occupancy.get(i) ?? 0) >= campaign.sessions_per_interval) continue;
    const { start, end } = blockRange(campaign, i);
    return { index: i, start, end };
  }
  return null;
}

/** Members with zero weekly-default rows AND zero specific overrides anywhere in the block — i.e. never engaged with this window at all. */
export async function getUnresponsiveMembers(
  campaignId: string,
  block: ActiveBlock
): Promise<Array<{ discordId: string; username: string }>> {
  const members: Array<{ discord_id: string; username: string }> = await db()("campaign_members")
    .join("users", "users.discord_id", "campaign_members.discord_id")
    .where("campaign_members.campaign_id", campaignId)
    .select("users.discord_id", "users.username");

  const hasAnyDefault = new Set(
    (await db()("default_availability").where({ campaign_id: campaignId }).distinct("discord_id")).map(
      (r: any) => r.discord_id
    )
  );
  const hasOverrideInBlock = new Set(
    (
      await db()("specific_availability")
        .where({ campaign_id: campaignId })
        .andWhere("date_utc", ">=", block.start)
        .andWhere("date_utc", "<", block.end)
        .distinct("discord_id")
    ).map((r: any) => r.discord_id)
  );

  return members
    .filter((m) => !hasAnyDefault.has(m.discord_id) && !hasOverrideInBlock.has(m.discord_id))
    .map((m) => ({ discordId: m.discord_id, username: m.username }));
}

function stageForDaysUntil(daysUntil: number, advanceDays: number, finalDays: number): 0 | 1 | 2 {
  if (daysUntil <= finalDays) return 2;
  if (daysUntil <= advanceDays) return 1;
  return 0;
}

/**
 * Checks every campaign with a configured webhook and sends at most one
 * reminder per (block, stage) — safe to call as often as the scheduler
 * likes, since state persists in campaigns.last_reminder_block_start/stage
 * and survives container restarts.
 */
export async function runReminderCheck(): Promise<void> {
  const campaigns = await db()("campaigns").whereNotNull("discord_webhook_url");

  for (const campaign of campaigns) {
    try {
      await checkCampaignReminder(campaign);
    } catch (err) {
      console.error(`[reminders] Failed for campaign ${campaign.id}:`, err);
    }
  }
}

async function checkCampaignReminder(campaign: any): Promise<void> {
  const block = await getActiveBlock(campaign.id);
  if (!block) return;

  const daysUntil = diffDays(todayUtc(), block.start);
  const stage = stageForDaysUntil(daysUntil, campaign.reminder_advance_days, campaign.reminder_final_days);
  if (stage === 0) return;

  const alreadyHandled = campaign.last_reminder_block_start === block.start && campaign.last_reminder_stage >= stage;
  if (alreadyHandled) return;

  const unresponsive = await getUnresponsiveMembers(campaign.id, block);

  if (unresponsive.length > 0) {
    const stageLabel = stage === 2 ? "**Final call**" : "Heads up";
    const mentions = unresponsive.map((m) => `<@${m.discordId}>`).join(" ");
    const blockEndDisplay = addDays(block.end, -1); // block.end is exclusive
    const content =
      `${stageLabel} — **${campaign.name}** needs availability for the window ${block.start} to ${blockEndDisplay}. ` +
      `Still waiting on: ${mentions}`;
    await sendDiscordMessage(campaign.discord_webhook_url, content);
  }

  await db()("campaigns")
    .where({ id: campaign.id })
    .update({ last_reminder_block_start: block.start, last_reminder_stage: stage });
}
