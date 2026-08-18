import crypto from "node:crypto";
import { db } from "../db/index.js";
import { localToday, type DateStr } from "./dateMath.js";

/** Marks (or re-marks) a member as having confirmed their availability for a specific block. Idempotent. */
export async function confirmBlock(campaignId: string, discordId: string, blockStart: DateStr): Promise<void> {
  await db()("block_confirmations")
    .insert({ id: crypto.randomUUID(), campaign_id: campaignId, discord_id: discordId, block_start: blockStart })
    .onConflict(["campaign_id", "discord_id", "block_start"])
    .merge({ confirmed_at: db().fn.now() });
}

export async function unconfirmBlock(campaignId: string, discordId: string, blockStart: DateStr): Promise<void> {
  await db()("block_confirmations").where({ campaign_id: campaignId, discord_id: discordId, block_start: blockStart }).delete();
}

export async function isBlockConfirmed(campaignId: string, discordId: string, blockStart: DateStr): Promise<boolean> {
  const row = await db()("block_confirmations")
    .where({ campaign_id: campaignId, discord_id: discordId, block_start: blockStart })
    .first();
  return !!row;
}

/**
 * Whenever a member writes ANY availability (default weekly template or a
 * specific date override), silently clear their confirmation on every
 * still-relevant block, rather than trying to be clever about exactly
 * which block(s) that particular write could affect — a default-template
 * change can ripple across many future blocks at once, and getting this
 * wrong in the "still shows confirmed" direction defeats the whole point
 * of the flag. Locked/completed blocks aren't touched: nothing left to
 * confirm there, and there's no ActiveBlock further out than
 * getActiveBlock reaches anyway, so this only ever prunes rows that
 * genuinely still matter for confirming.
 */
export async function invalidateFutureConfirmations(campaignId: string, discordId: string): Promise<void> {
  // "block_start >= today" needs the CAMPAIGN's own calendar date, not the
  // host's — getting this wrong in the direction of an earlier "today"
  // would skip clearing confirmations for blocks that are still upcoming
  // from the campaign's own perspective, leaving a stale "confirmed" flag
  // in place after the member actually changed their availability.
  const campaign = await db()("campaigns").where({ id: campaignId }).first();
  const today = campaign ? localToday(campaign.timezone) : new Date().toISOString().slice(0, 10);
  await db()("block_confirmations")
    .where({ campaign_id: campaignId, discord_id: discordId })
    .andWhere("block_start", ">=", today)
    .delete();
}

/** Per-member confirmation status for one block — used for the DM's "3/5 confirmed" indicator and the player's own checkbox state. */
export async function getBlockConfirmationStatus(
  campaignId: string,
  block: { start: DateStr }
): Promise<Record<string, boolean>> {
  const rows: Array<{ discord_id: string }> = await db()("block_confirmations").where({
    campaign_id: campaignId,
    block_start: block.start,
  });
  const confirmed = new Set(rows.map((r) => r.discord_id));
  const members: Array<{ discord_id: string }> = await db()("campaign_members").where({ campaign_id: campaignId });
  const status: Record<string, boolean> = {};
  for (const m of members) status[m.discord_id] = confirmed.has(m.discord_id);
  return status;
}
