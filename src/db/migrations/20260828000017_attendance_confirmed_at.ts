import type { Knex } from "knex";

/**
 * Attendance is passive by design (see session_absences' comment: "absent
 * by exception, present by default") — nobody has to do anything for a
 * session where everyone showed up. But sessionLifecycle's
 * autoCompletePastSessions() also flips 'scheduled' -> 'completed' purely
 * because the clock passed the end time, with zero DM input. Combined,
 * that means an auto-completed session silently reports "everyone
 * attended" even if nobody ever actually looked at it.
 *
 * This column distinguishes "the roster is the default because a DM
 * reviewed it and that's genuinely correct" from "the roster is the
 * default because nobody's looked yet" — NULL means the latter. Set
 * whenever a DM takes ANY action that implies they've looked at this
 * session's attendance: backfilling a completed session with an explicit
 * roster, toggling anyone's attendance, editing notes, or explicitly
 * confirming the default is correct as-is.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("sessions", (t) => {
    t.timestamp("attendance_confirmed_at").nullable();
  });
  // Backfill: any session that's already completed and has session_absences
  // rows (or is a pre-existing backfilled session, which always writes its
  // roster explicitly at creation) was already reviewed by definition, so
  // don't flag existing data as "unreviewed" retroactively — only sessions
  // completed AFTER this migration via the auto-complete path start out NULL.
  await knex("sessions").where({ status: "completed" }).update({ attendance_confirmed_at: knex.fn.now() });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("sessions", (t) => {
    t.dropColumn("attendance_confirmed_at");
  });
}
