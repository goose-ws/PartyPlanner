import crypto from "node:crypto";
import { DateTime } from "luxon";
import { db } from "../db/index.js";
import { addDays, type DateStr } from "./dateMath.js";
import { announceSessionLocked, announceSessionCancelled, announceBlockSkipped, announceSessionRescheduled } from "../discord/announcements.js";
import { blockIndexOf } from "./candidateEngine.js";

interface CampaignForLifecycle {
  id: string;
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

export async function lockSessionDate(campaignId: string, date: DateStr, publicUrl: string) {
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

  return { id: result.id, sessionNumber: result.sessionNumber, scheduledStartUtc: result.scheduledStartUtc, scheduledEndUtc: result.scheduledEndUtc };
}

/**
 * Cancels a scheduled session. If it was the most recently assigned number,
 * that number is released back (campaigns.last_session_number decrements),
 * so the next successful lock reuses it — matching "Session 12 gets
 * cancelled, the next successful session is still Session 12". If an
 * earlier (non-latest) session is cancelled instead, its number is left as
 * a historical marker rather than risking a collision with numbers already
 * assigned after it.
 */
export async function cancelSession(campaignId: string, sessionId: string) {
  const result = await db().transaction(async (trx) => {
    const session = await trx("sessions").where({ id: sessionId, campaign_id: campaignId }).first();
    if (!session) throw new Error("session_not_found");
    if (session.status !== "scheduled") throw new Error("only_scheduled_sessions_can_be_cancelled");

    const campaign: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();
    const wasLatest = session.session_number === campaign.last_session_number;

    await trx("sessions").where({ id: sessionId }).update({ status: "cancelled" });
    if (wasLatest) {
      await trx("campaigns")
        .where({ id: campaignId })
        .update({ last_session_number: Math.max(0, campaign.last_session_number - 1) });
    }

    return { campaign, sessionNumber: session.session_number as number };
  });

  await announceSessionCancelled(result.campaign, result.sessionNumber);
}

/**
 * Cancels the session AND flags its entire block as skipped, in one
 * transaction — for "we're not playing this whole block, not just moving
 * off this date" (distinct from a plain cancel, which reopens the block for
 * a fresh lock).
 */
export async function cancelBlock(campaignId: string, sessionId: string, notes: string | null) {
  const result = await db().transaction(async (trx) => {
    const session = await trx("sessions").where({ id: sessionId, campaign_id: campaignId }).first();
    if (!session) throw new Error("session_not_found");
    if (session.status !== "scheduled") throw new Error("only_scheduled_sessions_can_be_cancelled");

    const campaign: CampaignForLifecycle = await trx("campaigns").where({ id: campaignId }).first();
    const wasLatest = session.session_number === campaign.last_session_number;

    await trx("sessions").where({ id: sessionId }).update({ status: "cancelled" });
    if (wasLatest) {
      await trx("campaigns")
        .where({ id: campaignId })
        .update({ last_session_number: Math.max(0, campaign.last_session_number - 1) });
    }

    const { start, end } = blockRangeUtcDates(campaign, session.scheduled_start_utc.slice(0, 10));
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

    return { campaign, blockStart: start, blockEnd: end };
  });

  const blockEndInclusive = addDays(result.blockEnd, -1); // end is exclusive
  await announceBlockSkipped(result.campaign, result.blockStart, blockEndInclusive, notes);
}

/**
 * Moves an already-locked session to a new date, keeping the same session
 * number (unlike cancel+relock, which would churn the numbering). Blocked
 * only if the target date's block already has a *different* locked/completed
 * session filling its quota — the post-lock blackout window is deliberately
 * not enforced here, since a DM explicitly rescheduling their own session is
 * a considered decision, not the clustering the blackout guards against.
 */
export async function rescheduleSession(campaignId: string, sessionId: string, newDate: DateStr, publicUrl: string) {
  const result = await db().transaction(async (trx) => {
    const session = await trx("sessions").where({ id: sessionId, campaign_id: campaignId }).first();
    if (!session) throw new Error("session_not_found");
    if (session.status !== "scheduled") throw new Error("only_scheduled_sessions_can_be_rescheduled");

    const campaign: CampaignForLifecycle & { sessions_per_interval: number; blackout_days_after_lock: number } =
      await trx("campaigns").where({ id: campaignId }).first();

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

    return { campaign, sessionNumber: session.session_number as number, startUtc, endUtc };
  });

  await announceSessionRescheduled(result.campaign, sessionId, result.sessionNumber, result.startUtc, result.endUtc, publicUrl);
}

/** Flags an entire cadence block as intentionally skipped (e.g. a holiday break). */
export async function skipBlock(campaignId: string, anyDateInBlock: DateStr, notes: string | null) {
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
  return db()("sessions").where({ campaign_id: campaignId }).orderBy("scheduled_start_utc", "desc");
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
