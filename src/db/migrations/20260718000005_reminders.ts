import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    // Full webhook URL (https://discord.com/api/webhooks/ID/TOKEN) — root-only
    // to view/edit; anyone holding it can post into the channel, so it's
    // never returned to non-root API callers (see routes/campaigns.ts).
    t.text("discord_webhook_url").nullable();

    t.integer("reminder_advance_days").notNullable().defaultTo(14);
    t.integer("reminder_final_days").notNullable().defaultTo(2);

    // Tracks which block + stage was last notified, so the scheduler (which
    // may run many times while a block is open) sends each stage exactly
    // once, and container restarts don't cause duplicate pings.
    t.date("last_reminder_block_start").nullable();
    t.integer("last_reminder_stage").notNullable().defaultTo(0); // 0=none, 1=advance, 2=final
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropColumn("discord_webhook_url");
    t.dropColumn("reminder_advance_days");
    t.dropColumn("reminder_final_days");
    t.dropColumn("last_reminder_block_start");
    t.dropColumn("last_reminder_stage");
  });
}
