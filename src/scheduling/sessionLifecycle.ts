import crypto from "node:crypto";
import { DateTime } from "luxon";
import type { Knex } from "knex";
import { db } from "../db/index.js";
import { addDays, type DateStr } from "./dateMath.js";
import { announceSessionLocked, announceSessionCancelled, announceBlockSkipped, announceSessionRescheduled } from "../discord/announcements.js";
import { blockIndexOf } from "./candidateEngine.js";
import { logAudit } from "../audit.js";

interface CampaignForLifecycle {
  id: string;
  slug: string;
  name: string;
  start_date: DateStr;
  interval_weeks: number;
  session_time_start: string; // 'HH:MM:SS'
  session_time_end: string;
  timezone: string;
  last_session_number: number;
  discord_webhook_url: string | null;
}

/**
 * Re-derives session_number for every completed/scheduled session in a
 * campaign, purely from chronological date order (1, 2, 3, ... — no gaps).
 * Cancelled/skipped sessions are excluded entirely and keep session_number
 * null; they don't occupy a slot in the sequence. Called after anything
 * that could change which sessions are numbered or their relative order
 * (backfill, cancel, reschedule), so the numbering never needs manual
 * bookkeeping or produces stale/orphaned numbers.
 *
 * Two-phase update (temporary negative placeholders, then final values) —
 * a straight ascending pass would collide with itself under the
 * (campaign_id, session_number) uniqueness constraint whenever a session's
 * new number is still held by another row that hasn't been updated yet.
 */
async function renumberSessions(trx: Knex.Transaction, campaignId: string): Promise<void> {
  const ordered: Array<{ id: string }> = await trx("sessions")
    .where({ campaign_id: campaignId })
    .whereIn("status", ["scheduled", "completed"])
    .orderBy("scheduled_start_utc", "asc")
    .select("id");

  for (let i = 0; i < ordered.length; i++) {
    await trx("sessions").where({ id: ordered[i]!.id }).update({ session_number: -(i + 1) });
  }
  for (let i = 0; i < ordered.length; i++) {
    await trx("sessions").where({ id: ordered[i]!.id }).update({ session_number: i + 1 });
  }

  await trx("campaigns").where({ id: campaignId }).update({ last_session_number: ordered.length });
}

/**
 * Converts the campaign's fixed local session time on `date` to a UTC
 * instant, correctly accounting for the campaign's IANA timezone (including
 * DST) — this is the one place in the scheduling engine that needs real
 * timezone math; day-level availability scoring elsewhere deliberately
 * avoids it entirely.
 */
export function localSessionWindowToUtc(
  campaign: CampaignForLifecycle,
  date: DateStr
): { startUtc: Date; endUtc: Date } {
  const [sh, sm] = campaign.session_time_start.split(":").map(Number);
  const [eh, em] = campaign.session_time_end.split(":").map(Number);

  const start = DateTime.fromObject(
    { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10), hour: sh, minute: sm },
    { zone: campaign.timezone }
  );
  let end = DateTime.fromObject(
    { year: +date.slice(0, 4), month: +date.slice(5, 7), day: +date.slice(8, 10), hour: eh, minute: em },
    { zone: campaign.timezone }
  );
  // Session crosses midnight (e.g. 11 PM - 1 AM) — end lands the next day.
  if (end <= start) end = end.plus({ days: 1 });

  return { startUtc: start.toUTC().toJSDate(), endUtc: end.toUTC().toJSDate() };
}

function blockRangeUtcDates(campaign: CampaignForLifecycle, anyDateInBlock: DateStr): { start: DateStr; end: DateStr } {
  const blockLengthDays = campaign.interval_weeks * 7;
  const daysSinceAnchor = Math.floor(
    (new Date(anyDateInBlock).getTime() - new Date(campaign.start_date).getTime()) / 86_400_000
  );
  const blockIdx = Math.floor(daysSinceAnchor / blockLengthDays);
  const start = addDays(campaign.start_date, blockIdx * blockLengthDays);
  const end = addDays(start, blockLengthDays);
  return { start, end };
}

export async function lockSessionDate(campaignId: string, date: DateStr, publicUrl: string, actorDiscordId: string) {
  const result = await db().transaction(async (trx) => {
    const campaign: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();
    if (!campaign) throw new Error("campaign_not_found");

    const { startUtc, endUtc } = localSessionWindowToUtc(campaign, date);
    const nextNumber = campaign.last_session_number + 1;

    const id = crypto.randomUUID();
    await trx("sessions").insert({
      id,
      campaign_id: campaignId,
      session_number: nextNumber,
      scheduled_start_utc: startUtc,
      scheduled_end_utc: endUtc,
      status: "scheduled",
    });
    await trx("campaigns").where({ id: campaignId }).update({ last_session_number: nextNumber });

    return { id, sessionNumber: nextNumber, scheduledStartUtc: startUtc, scheduledEndUtc: endUtc, campaign };
  });

  // Sent after the transaction commits — a webhook hiccup shouldn't affect
  // whether the lock itself succeeded, and sendDiscordMessage never throws.
  await announceSessionLocked(result.campaign, result.id, result.sessionNumber, result.scheduledStartUtc, result.scheduledEndUtc, publicUrl);
  await logAudit("session.locked", {
    campaignId,
    actorDiscordId,
    detail: { sessionId: result.id, sessionNumber: result.sessionNumber, date },
  });

  return { id: result.id, sessionNumber: result.sessionNumber, scheduledStartUtc: result.scheduledStartUtc, scheduledEndUtc: result.scheduledEndUtc };
}

/**
 * Cancels a scheduled session and compacts the remaining numbered sessions
 * so there's never a gap or a stale/orphaned number left behind.
 */
export async function cancelSession(campaignId: string, sessionId: string, actorDiscordId: string) {
  const result = await db().transaction(async (trx) => {
    const session = await trx("sessions").where({ id: sessionId, campaign_id: campaignId }).first();
    if (!session) throw new Error("session_not_found");
    if (session.status !== "scheduled") throw new Error("only_scheduled_sessions_can_be_cancelled");

    await trx("sessions").where({ id: sessionId }).update({ status: "cancelled", session_number: null });
    await renumberSessions(trx, campaignId);

    const campaign: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();
    return { campaign, sessionNumber: session.session_number as number };
  });

  await announceSessionCancelled(result.campaign, result.sessionNumber);
  await logAudit("session.cancelled", { campaignId, actorDiscordId, detail: { sessionId, sessionNumber: result.sessionNumber } });
}

/**
 * Cancels the session AND flags its entire block as skipped, in one
 * transaction — for "we're not playing this whole block, not just moving
 * off this date" (distinct from a plain cancel, which reopens the block for
 * a fresh lock).
 */
export async function cancelBlock(campaignId: string, sessionId: string, notes: string | null, actorDiscordId: string) {
  const result = await db().transaction(async (trx) => {
    const session = await trx("sessions").where({ id: sessionId, campaign_id: campaignId }).first();
    if (!session) throw new Error("session_not_found");
    if (session.status !== "scheduled") throw new Error("only_scheduled_sessions_can_be_cancelled");

    const campaignForBlock: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();

    await trx("sessions").where({ id: sessionId }).update({ status: "cancelled", session_number: null });

    const { start, end } = blockRangeUtcDates(campaignForBlock, session.scheduled_start_utc.slice(0, 10));
    const skipId = crypto.randomUUID();
    await trx("sessions").insert({
      id: skipId,
      campaign_id: campaignId,
      session_number: null,
      scheduled_start_utc: `${start} 00:00:00`,
      scheduled_end_utc: `${end} 00:00:00`,
      status: "skipped",
      notes,
    });

    await renumberSessions(trx, campaignId);
    const campaign: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();
    return { campaign, blockStart: start, blockEnd: end };
  });

  const blockEndInclusive = addDays(result.blockEnd, -1); // end is exclusive
  await announceBlockSkipped(result.campaign, result.blockStart, blockEndInclusive, notes);
  await logAudit("block.skipped", { campaignId, actorDiscordId, detail: { sessionId, blockStart: result.blockStart, notes } });
}

/**
 * Moves an already-locked session to a new date, keeping the same session
 * number (unlike cancel+relock, which would churn the numbering). Blocked
 * only if the target date's block already has a *different* locked/completed
 * session filling its quota — the post-lock blackout window is deliberately
 * not enforced here, since a DM explicitly rescheduling their own session is
 * a considered decision, not the clustering the blackout guards against.
 */
export async function rescheduleSession(campaignId: string, sessionId: string, newDate: DateStr, publicUrl: string, actorDiscordId: string) {
  const result = await db().transaction(async (trx) => {
    const session = await trx("sessions").where({ id: sessionId, campaign_id: campaignId }).first();
    if (!session) throw new Error("session_not_found");
    if (session.status !== "scheduled") throw new Error("only_scheduled_sessions_can_be_rescheduled");

    const campaign: CampaignForLifecycle & {
      sessions_per_interval: number;
      blackout_days_after_lock: number;
      min_players_required: number;
    } = await trx("campaigns").where({ id: campaignId }).first();

    const targetBlockIdx = blockIndexOf(campaign, newDate);
    const otherSessions: Array<{ scheduled_start_utc: string; status: string }> = await trx("sessions")
      .where({ campaign_id: campaignId })
      .whereIn("status", ["scheduled", "completed"])
      .whereNot({ id: sessionId });
    const occupancy = otherSessions.filter(
      (s) => blockIndexOf(campaign, s.scheduled_start_utc.slice(0, 10)) === targetBlockIdx
    ).length;
    if (occupancy >= campaign.sessions_per_interval) {
      throw new Error("target_block_already_full");
    }

    const { startUtc, endUtc } = localSessionWindowToUtc(campaign, newDate);
    await trx("sessions")
      .where({ id: sessionId })
      .update({ scheduled_start_utc: startUtc, scheduled_end_utc: endUtc });

    // The date change can shift this session's chronological position
    // relative to the others, so its number may no longer be correct —
    // recompute the whole sequence rather than assume it's unaffected.
    await renumberSessions(trx, campaignId);
    const updated = await trx("sessions").where({ id: sessionId }).first();

    return { campaign, sessionNumber: updated.session_number as number, startUtc, endUtc };
  });

  await announceSessionRescheduled(result.campaign, sessionId, result.sessionNumber, result.startUtc, result.endUtc, publicUrl);
  await logAudit("session.rescheduled", { campaignId, actorDiscordId, detail: { sessionId, sessionNumber: result.sessionNumber, newDate } });
}

/**
 * Directly records a historical session — used to backfill sessions that
 * happened before this tool was in use. Deliberately bypasses ALL of the
 * forward-looking scheduling validation (block quotas, blackout, skipped
 * blocks) since none of that applies to something that already happened;
 * this just writes the row. Sends no Discord announcement — these are
 * retroactive, not news.
 *
 * No session number is taken as input — "completed" backfills are slotted
 * into the timeline by date and the whole sequence is renumbered from
 * scratch, so a session backfilled earlier than existing ones correctly
 * bumps everything after it rather than erroring on a number collision.
 * Cancelled/skipped backfills never get a number at all.
 */
export async function backfillSession(
  campaignId: string,
  input: {
    date: DateStr;
    status: "completed" | "cancelled" | "skipped";
    notes: string | null;
    absentDiscordIds: string[];
  },
  actorDiscordId: string
): Promise<{ id: string; sessionNumber: number | null }> {
  const result = await db().transaction(async (trx) => {
    const campaign: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();
    if (!campaign) throw new Error("campaign_not_found");

    const { startUtc, endUtc } = localSessionWindowToUtc(campaign, input.date);
    const id = crypto.randomUUID();

    await trx("sessions").insert({
      id,
      campaign_id: campaignId,
      session_number: null, // assigned below by renumberSessions if this is a "completed" backfill
      scheduled_start_utc: startUtc,
      scheduled_end_utc: endUtc,
      status: input.status,
      notes: input.notes,
    });

    for (const discordId of input.absentDiscordIds) {
      await trx("session_absences").insert({ session_id: id, discord_id: discordId, excused: true });
    }

    let sessionNumber: number | null = null;
    if (input.status === "completed") {
      await renumberSessions(trx, campaignId);
      const inserted = await trx("sessions").where({ id }).first();
      sessionNumber = inserted.session_number;
    }

    return { id, sessionNumber };
  });

  await logAudit("session.backfilled", {
    campaignId,
    actorDiscordId,
    detail: { sessionId: result.id, sessionNumber: result.sessionNumber, date: input.date, status: input.status },
  });

  return result;
}

/** Flags an entire cadence block as intentionally skipped (e.g. a holiday break). */
export async function skipBlock(campaignId: string, anyDateInBlock: DateStr, notes: string | null, actorDiscordId: string) {
  const campaign: CampaignForLifecycle = await db()("campaigns").where({ id: campaignId }).first();
  if (!campaign) throw new Error("campaign_not_found");

  const { start, end } = blockRangeUtcDates(campaign, anyDateInBlock);
  const id = crypto.randomUUID();
  await db()("sessions").insert({
    id,
    campaign_id: campaignId,
    session_number: null,
    scheduled_start_utc: `${start} 00:00:00`,
    scheduled_end_utc: `${end} 00:00:00`,
    status: "skipped",
    notes,
  });

  const blockEndInclusive = addDays(end, -1); // end is exclusive
  await announceBlockSkipped(campaign, start, blockEndInclusive, notes);
  await logAudit("block.skipped", { campaignId, actorDiscordId, detail: { blockStart: start, notes } });

  return { id, blockStart: start, blockEnd: end };
}

/** Lazily flips any 'scheduled' session whose end time has passed into 'completed'. Call before reading. */
export async function autoCompletePastSessions(campaignId: string): Promise<void> {
  await db()("sessions")
    .where({ campaign_id: campaignId, status: "scheduled" })
    .andWhere("scheduled_end_utc", "<", db().fn.now())
    .update({ status: "completed" });
}

export async function listSessions(campaignId: string) {
  await autoCompletePastSessions(campaignId);
  const sessions = await db()("sessions").where({ campaign_id: campaignId }).orderBy("scheduled_start_utc", "desc");
  if (sessions.length === 0) return sessions;

  const absences = await db()("session_absences")
    .whereIn(
      "session_id",
      sessions.map((s) => s.id)
    )
    .select("session_id", "discord_id");
  const bySession = new Map<string, string[]>();
  for (const a of absences) {
    const list = bySession.get(a.session_id) ?? [];
    list.push(a.discord_id);
    bySession.set(a.session_id, list);
  }
  return sessions.map((s) => ({ ...s, absent_discord_ids: bySession.get(s.id) ?? [] }));
}

/** Edits notes on a session after the fact — e.g. filling in a recap once a past session's already locked/completed. */
export async function updateSessionNotes(campaignId: string, sessionId: string, notes: string | null): Promise<void> {
  const updated = await db()("sessions").where({ id: sessionId, campaign_id: campaignId }).update({ notes });
  if (updated === 0) throw new Error("session_not_found");
}

/** Passive attendance: absent by exception, present by default (see session_absences). */
export async function markAbsent(sessionId: string, discordId: string, excused: boolean): Promise<void> {
  await db()("session_absences")
    .insert({ session_id: sessionId, discord_id: discordId, excused })
    .onConflict(["session_id", "discord_id"])
    .merge({ excused });
}

export async function clearAbsence(sessionId: string, discordId: string): Promise<void> {
  await db()("session_absences").where({ session_id: sessionId, discord_id: discordId }).delete();
}
