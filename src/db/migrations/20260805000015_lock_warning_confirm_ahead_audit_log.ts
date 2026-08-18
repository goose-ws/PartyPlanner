import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    // Third reminder type, distinct from advance/final: "you still haven't
    // locked ANY date for this block" — targets the DM specifically, not
    // players, since locking a date is a DM action. Independently
    // enable/disable-able and on its own day-count, same pattern as
    // reminder_advance_days/reminder_final_days.
    t.boolean("reminder_lock_warning_enabled").notNullable().defaultTo(true);
    t.integer("reminder_lock_warning_days").notNullable().defaultTo(2);
    t.date("last_reminder_lock_warning_block_start").nullable();

    // How many upcoming open blocks players are allowed to confirm ahead
    // of time — 1 means "just the immediate next block" (previous/default
    // behavior), higher values let a table that plans further out confirm
    // several sessions' worth of availability in one sitting.
    t.integer("confirm_ahead_sessions").notNullable().defaultTo(1);
  });

  await knex.schema.createTable("audit_log", (t) => {
    t.increments("id").primary();
    t.string("campaign_id", 36).nullable(); // no FK — logs should survive even if the campaign is later deleted
    t.string("actor_discord_id", 64).nullable(); // null for system/cron-triggered events (e.g. an automated reminder)
    t.string("event", 64).notNullable(); // dot-namespaced, e.g. "session.locked", "member.role_changed"
    t.text("detail").nullable(); // freeform JSON — whatever context is useful for that event type
    t.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    t.index(["campaign_id", "created_at"]);
    t.index(["event", "created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("audit_log");
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropColumn("reminder_lock_warning_enabled");
    t.dropColumn("reminder_lock_warning_days");
    t.dropColumn("last_reminder_lock_warning_block_start");
    t.dropColumn("confirm_ahead_sessions");
  });
}
