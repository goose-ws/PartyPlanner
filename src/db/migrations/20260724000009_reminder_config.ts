import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.time("reminder_time_of_day").notNullable().defaultTo("09:00:00");
    t.boolean("reminder_advance_enabled").notNullable().defaultTo(true);
    t.boolean("reminder_final_enabled").notNullable().defaultTo(true);
    t.boolean("reminder_dayof_enabled").notNullable().defaultTo(true);
  });

  await knex.schema.alterTable("sessions", (t) => {
    // Tracked per-session (not per-block, like advance/final) since a
    // day-of reminder is about one specific locked date.
    t.boolean("dayof_reminder_sent").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropColumn("reminder_time_of_day");
    t.dropColumn("reminder_advance_enabled");
    t.dropColumn("reminder_final_enabled");
    t.dropColumn("reminder_dayof_enabled");
  });
  await knex.schema.alterTable("sessions", (t) => {
    t.dropColumn("dayof_reminder_sent");
  });
}
