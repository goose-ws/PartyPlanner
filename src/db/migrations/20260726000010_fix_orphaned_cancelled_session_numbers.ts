import type { Knex } from "knex";

/**
 * Fixes data affected by a bug in cancelSession/cancelBlock: cancelling the
 * *latest* session correctly decremented campaigns.last_session_number (so
 * the number would be reused), but never actually cleared session_number on
 * the cancelled row itself — leaving a stale row that collides with the
 * next real lock's insert once the (campaign_id, session_number) uniqueness
 * constraint is in place.
 *
 * A cancelled row's number is only ever "supposed to be cleared" when it
 * exceeds the campaign's current last_session_number — a non-latest
 * cancellation intentionally keeps its number as a historical marker, and
 * that number will always be <= last_session_number since something else
 * became the new latest afterward. Anything above that line is exactly the
 * bug's leftover state.
 */
export async function up(knex: Knex): Promise<void> {
  const affected = await knex("sessions as s")
    .join("campaigns as c", "c.id", "s.campaign_id")
    .where("s.status", "cancelled")
    .whereNotNull("s.session_number")
    .whereRaw("s.session_number > c.last_session_number")
    .select("s.id", "s.campaign_id", "s.session_number");

  if (affected.length > 0) {
    console.log(`[migrate] Clearing stale session_number on ${affected.length} previously-cancelled session(s):`);
    for (const row of affected) {
      console.log(`  - session ${row.id} (campaign ${row.campaign_id}) had orphaned number ${row.session_number}`);
      await knex("sessions").where({ id: row.id }).update({ session_number: null });
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Not reversible — the original (buggy) numbers aren't worth restoring.
}
