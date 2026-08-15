import { DateTime } from "luxon";
import { db } from "../db/index.js";
import { blockIndexOf, blockRange, type CampaignCadence } from "./candidateEngine.js";
import { addDays, diffDays, maxDate, todayUtc, type DateStr } from "./dateMath.js";
import { sendDiscordMessage, type DiscordPayload } from "../discord/webhook.js";
import { getBlockConfirmationStatus } from "./blockConfirmations.js";
import { signConfirmToken } from "./confirmToken.js";
import type { AppConfig } from "../types/config.js";
import { logAudit } from "../audit.js";

const MAX_BLOCKS_TO_SCAN = 26; // ~1 year out at a 2-week cadence — safety bound, not a real limit

export interface ActiveBlock {
  index: number;
  start: DateStr;
  end: DateStr;
}

/**
 * The earliest N blocks, starting from today, that aren't skipped and
 * haven't already met their session quota — shared scanning logic behind
 * both getActiveBlock (limit=1, what reminders key off) and the
 * confirm-ahead window (limit=campaign.confirm_ahead_sessions, what the
 * Schedule tab's check-in card shows).
 */
export async function getOpenBlocks(campaignId: string, limit: number): Promise<ActiveBlock[]> {
  const campaign: CampaignCadence & { sessions_per_interval: number } = await db()("campaigns")
    .where({ id: campaignId })
    .first();
  if (!campaign) return [];

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
  const found: ActiveBlock[] = [];
  for (let i = startIdx; i < startIdx + MAX_BLOCKS_TO_SCAN && found.length < limit; i++) {
    if (skippedBlocks.has(i)) continue;
    if ((occupancy.get(i) ?? 0) >= campaign.sessions_per_interval) continue;
    const { start, end } = blockRange(campaign, i);
    found.push({ index: i, start, end });
  }
  return found;
}

/** The single earliest open block — what reminders and the lock/session flow key off. */
export async function getActiveBlock(campaignId: string): Promise<ActiveBlock | null> {
  return (await getOpenBlocks(campaignId, 1))[0] ?? null;
}

/** Members who have NOT explicitly confirmed their availability for this block — regardless of whether they have any default/override rows at all. This is who advance/final reminders ping. */
export async function getUnconfirmedMembers(
  campaignId: string,
  block: ActiveBlock
): Promise<Array<{ discordId: string; username: string }>> {
  const members: Array<{ discord_id: string; username: string }> = await db()("campaign_members")
    .join("users", "users.discord_id", "campaign_members.discord_id")
    .where("campaign_members.campaign_id", campaignId)
    .select("users.discord_id", "users.username");

  const status = await getBlockConfirmationStatus(campaignId, block);
  return members.filter((m) => !status[m.discord_id]).map((m) => ({ discordId: m.discord_id, username: m.username }));
}

const WEIGHT_LABELS = ["No", "Maybe", "If Needed", "Yes"];
const WEIGHT_EMOJI = ["🔴", "🟠", "🟡", "🟢"]; // index == weight (0..3)
const EMBED_COLOR = 0xc08a2e; // matches the brand gold used in announcements.ts

function stageForDaysUntil(daysUntil: number, advanceDays: number, finalDays: number): 0 | 1 | 2 {
  if (daysUntil <= finalDays) return 2;
  if (daysUntil <= advanceDays) return 1;
  return 0;
}

/**
 * One member's weight for every calendar day in a block — shown back to
 * them in their reminder so "confirm" means something (they can actually
 * see what's on file, not just click a link blind).
 */
async function getMemberAvailabilityForBlock(
  campaignId: string,
  discordId: string,
  block: ActiveBlock
): Promise<Array<{ date: DateStr; weight: number; joiningLate: boolean; droppingEarly: boolean }>> {
  const defaults: Array<{ day_of_week: number; weight: number }> = await db()("default_availability").where({
    campaign_id: campaignId,
    discord_id: discordId,
  });
  const specific: Array<{ date_utc: DateStr; weight: number; joining_late: boolean; dropping_early: boolean }> = await db()(
    "specific_availability"
  )
    .where({ campaign_id: campaignId, discord_id: discordId })
    .andWhere("date_utc", ">=", block.start)
    .andWhere("date_utc", "<", block.end);

  const defaultByDow = new Map(defaults.map((d) => [d.day_of_week, d.weight]));
  const specificByDate = new Map(specific.map((s) => [s.date_utc, s]));

  const days: Array<{ date: DateStr; weight: number; joiningLate: boolean; droppingEarly: boolean }> = [];
  for (let cursor = block.start; cursor < block.end; cursor = addDays(cursor, 1)) {
    const override = specificByDate.get(cursor);
    const dow = new Date(cursor + "T00:00:00Z").getUTCDay();
    days.push({
      date: cursor,
      weight: override?.weight ?? defaultByDow.get(dow) ?? 0,
      joiningLate: !!override?.joining_late,
      droppingEarly: !!override?.dropping_early,
    });
  }
  return days;
}

const SHORT_WEIGHT_LABELS = ["No", "Mb", "If", "Yes"]; // compact form of WEIGHT_LABELS for the narrow grid — "Maybe"/"If Needed" don't fit
const GRID_COL_WIDTH = 6;

/**
 * Renders a member's block availability as a mini calendar — one row of
 * narrow-weekday+date headers, one row of responses, grouped Sun–Sat like a
 * real calendar (not just the raw block range), with a blank row between
 * weeks. Days outside the block but inside a partial first/last week still
 * show their date (so the grid reads as a real week) but with a blank
 * response cell.
 *
 * Deliberately compact for mobile: narrow single-letter weekdays (Luxon's
 * "ccccc" token — Tue and Thu both render "T", which is normal for narrow
 * weekday format and unambiguous next to the date number), 2-letter
 * response codes, and only ONE month label at the very top. A block never
 * spans more than a couple of months, so a mid-grid month change is just
 * left implicit (the day number rolling from ~28-31 back down to 1..7 says
 * it plainly enough) rather than spending a whole row on a second label.
 */
function buildAvailabilityGrid(days: Array<{ date: DateStr; weight: number; joiningLate: boolean; droppingEarly: boolean }>): string {
  if (days.length === 0) return "(nothing on file for this window)";

  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days[0]!.date;
  const last = days[days.length - 1]!.date;

  // Luxon weekday is Mon=1..Sun=7 — %7 remaps to Sun=0..Sat=6 to match the grid's Sun-first columns.
  const firstDowSun0 = DateTime.fromISO(first, { zone: "utc" }).weekday % 7;
  const lastDowSun0 = DateTime.fromISO(last, { zone: "utc" }).weekday % 7;
  const gridStart = addDays(first, -firstDowSun0);
  const gridEndInclusive = addDays(last, 6 - lastDowSun0);

  const lines: string[] = [DateTime.fromISO(gridStart, { zone: "utc" }).toFormat("LLL")];
  let anyFlags = false;
  let firstWeek = true;

  for (let weekStart = gridStart; weekStart <= gridEndInclusive; weekStart = addDays(weekStart, 7)) {
    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    if (!firstWeek) lines.push("");
    firstWeek = false;

    const headerRow = weekDates
      .map((d) => `${DateTime.fromISO(d, { zone: "utc" }).toFormat("ccccc")} ${Number(d.slice(8, 10))}`.padEnd(GRID_COL_WIDTH))
      .join("");
    const responseRow = weekDates
      .map((d) => {
        const info = byDate.get(d);
        if (!info) return "".padEnd(GRID_COL_WIDTH);
        const flagSuffix = [info.joiningLate && "L", info.droppingEarly && "E"].filter(Boolean).join("");
        if (flagSuffix) anyFlags = true;
        return `${SHORT_WEIGHT_LABELS[info.weight]}${flagSuffix ? ` ${flagSuffix}` : ""}`.padEnd(GRID_COL_WIDTH);
      })
      .join("");

    lines.push(headerRow.trimEnd());
    lines.push(responseRow.trimEnd());
  }

  if (anyFlags) lines.push("", "L = late  E = early");
  return lines.join("\n");
}

/**
 * One message, one recipient — a hard character-limit concern with a
 * combined "still need to confirm: @a @b @c..." message goes away
 * entirely once each person gets their own, and it means we have the room
 * to actually show them their day-by-day breakdown instead of just a bare
 * link. The breakdown grid goes in a ```code block``` (no mentions inside
 * it, so that's safe); the @mention and confirm link stay in plain text
 * outside it so the mention still triggers a real notification.
 */
/**
 * One message, one recipient — a hard character-limit concern with a
 * combined "still need to confirm: @a @b @c..." message goes away
 * entirely once each person gets their own, and it means we have the room
 * to actually show them their day-by-day breakdown instead of just a bare
 * link. The breakdown grid goes in a ```code block``` (no mentions inside
 * it, so that's safe); the @mention and links stay in plain text outside
 * it so the mention still triggers a real notification.
 *
 * Links use `[text](<url>)` — the `<url>` INSIDE the parens suppresses
 * Discord's automatic link-preview embed (which for the long signed
 * confirm token was showing up as a huge, useless preview box) while still
 * keeping the nice masked-link display text.
 */
function buildPerUserStageMessage(
  cfg: AppConfig,
  campaignId: string,
  campaignName: string,
  campaignSlug: string,
  block: ActiveBlock,
  member: { discordId: string },
  days: Array<{ date: DateStr; weight: number; joiningLate: boolean; droppingEarly: boolean }>,
  stage: 1 | 2
): string {
  const stageLabel = stage === 2 ? "⏰ **Final call**" : "👋 **Heads up**";
  const blockEndDisplay = addDays(block.end, -1); // block.end is exclusive
  const token = signConfirmToken(cfg, campaignId, member.discordId, block.start);
  const confirmLink = `${cfg.publicUrl}/confirm/${token}`;
  const scheduleLink = `${cfg.publicUrl}/campaigns/${campaignSlug}`;
  return (
    `${stageLabel} — **${campaignName}**\n` +
    `<@${member.discordId}>, here's what's on file for ${block.start} to ${blockEndDisplay}:\n` +
    "```\n" +
    buildAvailabilityGrid(days) +
    "\n```\n" +
    `Still correct?\n` +
    `✅ [Click to Confirm](<${confirmLink}>)\n` +
    `✏️ [Need to change something?](<${scheduleLink}>)`
  );
}

/** Every member's weight + late/early flags + exclusion status for one specific date — used to build the day-of roster. */
export async function getResponsesForDate(
  campaignId: string,
  date: DateStr
): Promise<
  Array<{
    discordId: string;
    username: string;
    weight: number;
    joiningLate: boolean;
    droppingEarly: boolean;
    excluded: boolean;
    role: "DM" | "Player";
  }>
> {
  const members: Array<{ discord_id: string; username: string; excluded_from_scoring: boolean; role: "DM" | "Player" }> = await db()(
    "campaign_members"
  )
    .join("users", "users.discord_id", "campaign_members.discord_id")
    .where("campaign_members.campaign_id", campaignId)
    .select("users.discord_id", "users.username", "campaign_members.excluded_from_scoring", "campaign_members.role");

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
      excluded: !!m.excluded_from_scoring,
      role: m.role,
    };
  });
}

export interface ScoringSettings {
  late_early_penalty: number;
  dm_maybe_modifier: number;
  dm_if_needed_modifier: number;
}

/** Raw weight, DM-only Maybe/If-Needed modifier, minus the configured late/early penalty per active flag, floored at 0 — mirrors candidateEngine's contributionFor exactly. */
function contributionFor(
  r: { weight: number; joiningLate: boolean; droppingEarly: boolean; role: "DM" | "Player" },
  settings: ScoringSettings
): number {
  const isDm = r.role === "DM";
  const dmAdjust = isDm && r.weight === 1 ? settings.dm_maybe_modifier : isDm && r.weight === 2 ? settings.dm_if_needed_modifier : 0;
  const penalty = settings.late_early_penalty;
  const deduction = (r.joiningLate ? penalty : 0) + (r.droppingEarly ? penalty : 0);
  return Math.max(0, r.weight + dmAdjust - deduction);
}

/**
 * Roster lines for the embed description — one per player/DM, each led by
 * a colored dot for their response and an @mention (so Discord renders it
 * as highlighted/clickable text) rather than a plain username. This is
 * cosmetic highlighting only: mentions inside an embed do NOT trigger a
 * notification, only ones in top-level `content` do (see buildPerUserStageMessage).
 * Points shown are the flag-adjusted contribution (matching the calendar's
 * ScoreTag), not the raw response weight — a "Yes" who's joining late reads
 * as 2.5 pts here, same as everywhere else in the app. Excluded members are
 * still listed (so it's clear they responded) but visibly marked as not
 * counting toward the total.
 */
export function rosterLines(
  responses: Array<{
    discordId: string;
    weight: number;
    joiningLate: boolean;
    droppingEarly: boolean;
    excluded: boolean;
    role: "DM" | "Player";
  }>,
  settings: ScoringSettings
): string {
  if (responses.length === 0) return "_(no one on the roster yet)_";
  return responses
    .map((r) => {
      const flags = [r.joiningLate && "joining late", r.droppingEarly && "dropping early"].filter(Boolean).join(", ");
      const pts = contributionFor(r, settings);
      const ptsDisplay = Number.isInteger(pts) ? String(pts) : pts.toFixed(1);
      if (r.excluded) {
        return `${WEIGHT_EMOJI[r.weight]} <@${r.discordId}> — ${WEIGHT_LABELS[r.weight]} _(excluded from scoring)_`;
      }
      const label = `${WEIGHT_LABELS[r.weight]} (${ptsDisplay} pt${pts === 1 ? "" : "s"})`;
      return `${WEIGHT_EMOJI[r.weight]} <@${r.discordId}> — ${label}${flags ? ` · ${flags}` : ""}`;
    })
    .join("\n");
}

function buildDayOfPayload(
  campaignName: string,
  session: { session_number: number | null; scheduled_start_utc: string },
  timezone: string,
  responses: Array<{
    discordId: string;
    weight: number;
    joiningLate: boolean;
    droppingEarly: boolean;
    excluded: boolean;
    role: "DM" | "Player";
  }>,
  settings: ScoringSettings
): DiscordPayload {
  const when = DateTime.fromJSDate(new Date(session.scheduled_start_utc.replace(" ", "T") + "Z"), { zone: "utc" })
    .setZone(timezone)
    .toFormat("h:mm a ZZZZ");
  const description = `🎲 Session ${session.session_number} is today at **${when}**\n\n**Roster:**\n${rosterLines(responses, settings)}`;
  return {
    embeds: [
      {
        title: `Today: ${campaignName} — Session ${session.session_number}`,
        color: EMBED_COLOR,
        description,
      },
    ],
  };
}

/** Composes (without sending) the advance/final reminder messages that WOULD go out right now, for previewing or testing — one per unconfirmed member. */
export async function composeStageReminder(
  cfg: AppConfig,
  campaignId: string,
  stage: 1 | 2
): Promise<
  | { ok: true; messages: Array<{ discordId: string; username: string; content: string }>; block: ActiveBlock }
  | { ok: false; reason: string }
> {
  const campaign = await db()("campaigns").where({ id: campaignId }).first();
  if (!campaign) return { ok: false, reason: "campaign_not_found" };
  const block = await getActiveBlock(campaignId);
  if (!block) return { ok: false, reason: "no_open_block" };
  const unconfirmed = await getUnconfirmedMembers(campaignId, block);

  const messages = await Promise.all(
    unconfirmed.map(async (m) => {
      const days = await getMemberAvailabilityForBlock(campaignId, m.discordId, block);
      return {
        discordId: m.discordId,
        username: m.username,
        content: buildPerUserStageMessage(cfg, campaignId, campaign.name, campaign.slug, block, m, days, stage),
      };
    })
  );

  return { ok: true, messages, block };
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
  const payload = buildDayOfPayload(campaign.name, session, campaign.timezone, responses, campaign);
  // The preview/test UI just shows plain text, so surface the embed's
  // description — @mentions won't resolve there, but the structure is
  // otherwise exactly what gets posted to Discord.
  return { ok: true, content: payload.embeds![0]!.description! };
}

function isPastLocalTime(timezone: string, timeOfDay: string): boolean {
  const nowLocal = DateTime.now().setZone(timezone).toFormat("HH:mm");
  return nowLocal >= timeOfDay.slice(0, 5);
}

function localToday(timezone: string): DateStr {
  return DateTime.now().setZone(timezone).toFormat("yyyy-LL-dd");
}

/** The session's actual local calendar date in the campaign's timezone — NOT scheduled_start_utc.slice(0,10), which is the UTC date and can differ near midnight. */
export function localDateOf(mysqlDatetimeUtc: string, timezone: string): DateStr {
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
export async function runReminderCheck(cfg: AppConfig): Promise<void> {
  const campaigns = await db()("campaigns").whereNotNull("discord_webhook_url");

  for (const campaign of campaigns) {
    try {
      if (!isPastLocalTime(campaign.timezone, campaign.reminder_time_of_day)) continue;
      await checkStageReminder(cfg, campaign);
      await checkDayOfReminder(campaign);
      await checkLockWarning(campaign);
    } catch (err) {
      console.error(`[reminders] Failed for campaign ${campaign.id}:`, err);
    }
  }
}

async function checkStageReminder(cfg: AppConfig, campaign: any): Promise<void> {
  const block = await getActiveBlock(campaign.id);
  if (!block) return;

  const daysUntil = diffDays(todayUtc(), block.start);
  const stage = stageForDaysUntil(daysUntil, campaign.reminder_advance_days, campaign.reminder_final_days);
  if (stage === 0) return;
  if (stage === 1 && !campaign.reminder_advance_enabled) return;
  if (stage === 2 && !campaign.reminder_final_enabled) return;

  const alreadyHandled = campaign.last_reminder_block_start === block.start && campaign.last_reminder_stage >= stage;
  if (alreadyHandled) return;

  // "Only if anyone is unconfirmed" — no point pinging an already-settled table.
  const unconfirmed = await getUnconfirmedMembers(campaign.id, block);
  for (const member of unconfirmed) {
    const days = await getMemberAvailabilityForBlock(campaign.id, member.discordId, block);
    const content = buildPerUserStageMessage(cfg, campaign.id, campaign.name, campaign.slug, block, member, days, stage as 1 | 2);
    await sendDiscordMessage(campaign.discord_webhook_url, { content });
  }
  if (unconfirmed.length > 0) {
    await logAudit("reminder.stage_sent", {
      campaignId: campaign.id,
      detail: { stage, blockStart: block.start, recipientCount: unconfirmed.length },
    });
  }

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
  const payload = buildDayOfPayload(campaign.name, session, campaign.timezone, responses, campaign);
  await sendDiscordMessage(campaign.discord_webhook_url, payload);
  await db()("sessions").where({ id: session.id }).update({ dayof_reminder_sent: true });
  await logAudit("reminder.dayof_sent", { campaignId: campaign.id, detail: { sessionId: session.id, sessionNumber: session.session_number } });
}

/**
 * Third reminder type, distinct from the confirm-nagging advance/final
 * ones: "you (the DM) haven't locked ANY date for this block yet." Fires
 * reminder_lock_warning_days before the block's first possible date,
 * targets the DM specifically (locking a date is a DM action, not a
 * player one), and — like the others — is a no-op once a date's been
 * locked, so it never fires "for nothing."
 */
async function checkLockWarning(campaign: any): Promise<void> {
  if (!campaign.reminder_lock_warning_enabled) return;

  const block = await getActiveBlock(campaign.id);
  if (!block) return; // nothing open (e.g. everything's already locked/skipped) — nothing to warn about

  const daysUntil = diffDays(todayUtc(), block.start);
  if (daysUntil > campaign.reminder_lock_warning_days) return; // not time yet
  if (daysUntil < 0) return; // block's already underway — advance/final already covered this urgency

  if (campaign.last_reminder_lock_warning_block_start === block.start) return; // already warned for this exact block

  // getActiveBlock already only returns blocks that haven't met their
  // session quota — for the common sessions_per_interval=1 case that's
  // equivalent to "nothing locked yet," but check occupancy explicitly so
  // this stays correct for campaigns that run multiple sessions per block.
  const occupancy = await db()("sessions")
    .where({ campaign_id: campaign.id })
    .whereIn("status", ["scheduled", "completed"])
    .andWhere("scheduled_start_utc", ">=", `${block.start} 00:00:00`)
    .andWhere("scheduled_start_utc", "<", `${block.end} 00:00:00`)
    .count("* as count")
    .first();
  if (Number(occupancy?.count ?? 0) > 0) return;

  const dms: Array<{ discord_id: string }> = await db()("campaign_members").where({ campaign_id: campaign.id, role: "DM" });
  if (dms.length === 0) return;

  const blockEndDisplay = addDays(block.end, -1);
  const mentions = dms.map((d) => `<@${d.discord_id}>`).join(" ");
  const content =
    `📅 **${campaign.name}** doesn't have a session locked in yet for ${block.start} to ${blockEndDisplay}.\n` +
    `${mentions}, time to pick a date!`;
  await sendDiscordMessage(campaign.discord_webhook_url, { content });
  await db()("campaigns").where({ id: campaign.id }).update({ last_reminder_lock_warning_block_start: block.start });
  await logAudit("reminder.lock_warning_sent", { campaignId: campaign.id, detail: { blockStart: block.start, dmCount: dms.length } });
}