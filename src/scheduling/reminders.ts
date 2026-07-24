import { DateTime } from "luxon";
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

const WEIGHT_LABELS = ["No", "Maybe", "If Needed", "Yes"];

function stageForDaysUntil(daysUntil: number, advanceDays: number, finalDays: number): 0 | 1 | 2 {
  if (daysUntil <= finalDays) return 2;
  if (daysUntil <= advanceDays) return 1;
  return 0;
}

function buildStageMessage(campaignName: string, block: ActiveBlock, unresponsive: Array<{ discordId: string }>, stage: 1 | 2): string | null {
  if (unresponsive.length === 0) return null;
  const stageLabel = stage === 2 ? "**Final call**" : "Heads up";
  const mentions = unresponsive.map((m) => `<@${m.discordId}>`).join(" ");
  const blockEndDisplay = addDays(block.end, -1); // block.end is exclusive
  return (
    `${stageLabel} — **${campaignName}** needs availability for the window ${block.start} to ${blockEndDisplay}. ` +
    `Still waiting on: ${mentions}`
  );
}

/** Every member's weight + late/early flags for one specific date — used to build the day-of roster. */
async function getResponsesForDate(
  campaignId: string,
  date: DateStr
): Promise<Array<{ discordId: string; username: string; weight: number; joiningLate: boolean; droppingEarly: boolean }>> {
  const members: Array<{ discord_id: string; username: string }> = await db()("campaign_members")
    .join("users", "users.discord_id", "campaign_members.discord_id")
    .where("campaign_members.campaign_id", campaignId)
    .select("users.discord_id", "users.username");

  const defaults: Array<{ discord_id: string; day_of_week: number; weight: number }> = await db()("default_availability").where({
    campaign_id: campaignId,
  });
  const specific: Array<{ discord_id: string; weight: number; joining_late: boolean; dropping_early: boolean }> = await db()(
    "specific_availability"
  ).where({ campaign_id: campaignId, date_utc: date });

  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  const defaultByMember = new Map(defaults.filter((d) => d.day_of_week === dow).map((d) => [d.discord_id, d.weight]));
  const specificByMember = new Map(specific.map((s) => [s.discord_id, s]));

  return members.map((m) => {
    const override = specificByMember.get(m.discord_id);
    return {
      discordId: m.discord_id,
      username: m.username,
      weight: override?.weight ?? defaultByMember.get(m.discord_id) ?? 0,
      joiningLate: !!override?.joining_late,
      droppingEarly: !!override?.dropping_early,
    };
  });
}

function buildDayOfMessage(
  campaignName: string,
  session: { session_number: number | null; scheduled_start_utc: string },
  timezone: string,
  responses: Array<{ username: string; weight: number; joiningLate: boolean; droppingEarly: boolean }>
): string {
  const when = DateTime.fromJSDate(new Date(session.scheduled_start_utc.replace(" ", "T") + "Z"), { zone: "utc" })
    .setZone(timezone)
    .toFormat("h:mm a ZZZZ");
  const roster = responses
    .map((r) => {
      const flags = [r.joiningLate && "joining late", r.droppingEarly && "dropping early"].filter(Boolean).join(", ");
      return `${r.username}: ${WEIGHT_LABELS[r.weight]}${flags ? ` (${flags})` : ""}`;
    })
    .join(" · ");
  return `🎲 **${campaignName}** — Session ${session.session_number} is today at **${when}**.\n${roster}`;
}

/** Composes (without sending) the advance/final reminder that WOULD go out right now, for previewing or testing. */
export async function composeStageReminder(
  campaignId: string,
  stage: 1 | 2
): Promise<{ ok: true; content: string | null; block: ActiveBlock } | { ok: false; reason: string }> {
  const campaign = await db()("campaigns").where({ id: campaignId }).first();
  if (!campaign) return { ok: false, reason: "campaign_not_found" };
  const block = await getActiveBlock(campaignId);
  if (!block) return { ok: false, reason: "no_open_block" };
  const unresponsive = await getUnresponsiveMembers(campaignId, block);
  return { ok: true, content: buildStageMessage(campaign.name, block, unresponsive, stage), block };
}

/** Composes (without sending) the day-of reminder for the next locked session, for previewing or testing. */
export async function composeDayOfReminder(campaignId: string): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const campaign = await db()("campaigns").where({ id: campaignId }).first();
  if (!campaign) return { ok: false, reason: "campaign_not_found" };

  const session = await db()("sessions")
    .where({ campaign_id: campaignId, status: "scheduled" })
    .orderBy("scheduled_start_utc", "asc")
    .first();
  if (!session) return { ok: false, reason: "no_upcoming_session" };

  const responses = await getResponsesForDate(campaignId, localDateOf(session.scheduled_start_utc, campaign.timezone));
  return { ok: true, content: buildDayOfMessage(campaign.name, session, campaign.timezone, responses) };
}

function isPastLocalTime(timezone: string, timeOfDay: string): boolean {
  const nowLocal = DateTime.now().setZone(timezone).toFormat("HH:mm");
  return nowLocal >= timeOfDay.slice(0, 5);
}

function localToday(timezone: string): DateStr {
  return DateTime.now().setZone(timezone).toFormat("yyyy-LL-dd");
}

/** The session's actual local calendar date in the campaign's timezone — NOT scheduled_start_utc.slice(0,10), which is the UTC date and can differ near midnight. */
function localDateOf(mysqlDatetimeUtc: string, timezone: string): DateStr {
  return DateTime.fromJSDate(new Date(mysqlDatetimeUtc.replace(" ", "T") + "Z"), { zone: "utc" })
    .setZone(timezone)
    .toFormat("yyyy-LL-dd");
}

/**
 * Checks every campaign with a configured webhook and sends at most one
 * advance/final reminder per (block, stage), plus at most one day-of
 * reminder per session — safe to call as often as the scheduler likes,
 * since all state persists in the DB and survives container restarts.
 * Each reminder type only fires once local time (in the campaign's own
 * timezone) has passed the campaign's configured reminder_time_of_day.
 */
export async function runReminderCheck(): Promise<void> {
  const campaigns = await db()("campaigns").whereNotNull("discord_webhook_url");

  for (const campaign of campaigns) {
    try {
      if (!isPastLocalTime(campaign.timezone, campaign.reminder_time_of_day)) continue;
      await checkStageReminder(campaign);
      await checkDayOfReminder(campaign);
    } catch (err) {
      console.error(`[reminders] Failed for campaign ${campaign.id}:`, err);
    }
  }
}

async function checkStageReminder(campaign: any): Promise<void> {
  const block = await getActiveBlock(campaign.id);
  if (!block) return;

  const daysUntil = diffDays(todayUtc(), block.start);
  const stage = stageForDaysUntil(daysUntil, campaign.reminder_advance_days, campaign.reminder_final_days);
  if (stage === 0) return;
  if (stage === 1 && !campaign.reminder_advance_enabled) return;
  if (stage === 2 && !campaign.reminder_final_enabled) return;

  const alreadyHandled = campaign.last_reminder_block_start === block.start && campaign.last_reminder_stage >= stage;
  if (alreadyHandled) return;

  const unresponsive = await getUnresponsiveMembers(campaign.id, block);
  const content = buildStageMessage(campaign.name, block, unresponsive, stage as 1 | 2);
  if (content) await sendDiscordMessage(campaign.discord_webhook_url, content);

  await db()("campaigns")
    .where({ id: campaign.id })
    .update({ last_reminder_block_start: block.start, last_reminder_stage: stage });
}

async function checkDayOfReminder(campaign: any): Promise<void> {
  if (!campaign.reminder_dayof_enabled) return;

  const today = localToday(campaign.timezone);
  // Fetched and filtered in JS rather than via a SQL DATE() comparison —
  // DATE(scheduled_start_utc) would truncate the UTC date, not the
  // campaign's local date, which silently misfires near midnight for
  // timezones/session times where the local and UTC calendar day differ.
  const candidates: Array<{ id: string; session_number: number | null; scheduled_start_utc: string }> = await db()("sessions").where({
    campaign_id: campaign.id,
    status: "scheduled",
    dayof_reminder_sent: false,
  });
  const session = candidates.find((s) => localDateOf(s.scheduled_start_utc, campaign.timezone) === today);
  if (!session) return;

  const responses = await getResponsesForDate(campaign.id, localDateOf(session.scheduled_start_utc, campaign.timezone));
  const content = buildDayOfMessage(campaign.name, session, campaign.timezone, responses);
  await sendDiscordMessage(campaign.discord_webhook_url, content);
  await db()("sessions").where({ id: session.id }).update({ dayof_reminder_sent: true });
}
