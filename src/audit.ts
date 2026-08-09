import { db } from "./db/index.js";

/**
 * Dot-namespaced event names, grouped by subsystem. Add to this list as new
 * event types are logged — keeping it as a union (rather than a bare
 * string) means a typo in a call site is a compile error, not a silently
 * unsearchable audit row.
 */
export type AuditEvent =
  | "campaign.created"
  | "campaign.settings_updated"
  | "session.locked"
  | "session.cancelled"
  | "session.rescheduled"
  | "session.backfilled"
  | "block.skipped"
  | "invite.created"
  | "invite.redeemed"
  | "invite.revoked"
  | "member.role_changed"
  | "member.removed"
  | "member.exclusion_toggled"
  | "availability.default_changed"
  | "availability.specific_changed"
  | "block.confirmed"
  | "block.confirmed_by_manager"
  | "block.unconfirmed"
  | "block.unconfirmed_by_manager"
  | "reminder.stage_sent"
  | "reminder.dayof_sent"
  | "reminder.lock_warning_sent"
  | "webhook.test_sent"
  | "auth.login";

/**
 * Fire-and-forget by design: a logging failure should never break the
 * actual operation it's describing. Errors here are swallowed (after a
 * console.error, which still lands in the container's own log) rather than
 * propagated.
 */
export async function logAudit(
  event: AuditEvent,
  opts: { campaignId?: string | null; actorDiscordId?: string | null; detail?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await db()("audit_log").insert({
      campaign_id: opts.campaignId ?? null,
      actor_discord_id: opts.actorDiscordId ?? null,
      event,
      detail: opts.detail ? JSON.stringify(opts.detail) : null,
    });
  } catch (err) {
    console.error(`[audit] Failed to log event "${event}":`, err);
  }
}
