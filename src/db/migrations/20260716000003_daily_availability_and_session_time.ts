import type { Knex } from "knex";

/**
 * Reshapes availability from "one weight per hour-slot" to "one weight per
 * calendar day" — the hourly grid is deferred; for now the whole group plays
 * at the same fixed time every session (session_time_start/end, new on
 * campaigns), so a single day-level Yes/If Needed/Maybe/No is what actually
 * gets scored. Hourly granularity can be layered back in later without
 * disturbing this shape (it'd add a new table alongside these, not replace
 * them again).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.time("session_time_start").notNullable().defaultTo("19:00:00");
    t.time("session_time_end").notNullable().defaultTo("23:00:00");
    t.string("timezone", 50).notNullable().defaultTo("America/New_York");
  });

  await knex.schema.dropTable("default_availability");
  await knex.schema.createTable("default_availability", (t) => {
    t.string("campaign_id", 36).notNullable();
    t.string("discord_id", 64).notNullable();
    t.integer("day_of_week").notNullable(); // 0 (Sun) - 6 (Sat)
    t.integer("weight").notNullable().defaultTo(0); // 0..3
    t.primary(["campaign_id", "discord_id", "day_of_week"]);
    t.foreign(["campaign_id", "discord_id"])
      .references(["campaign_id", "discord_id"])
      .inTable("campaign_members")
      .onDelete("CASCADE");
  });

  await knex.schema.dropTable("specific_availability");
  await knex.schema.createTable("specific_availability", (t) => {
    t.string("campaign_id", 36).notNullable();
    t.string("discord_id", 64).notNullable();
    t.date("date_utc").notNullable();
    t.integer("weight").notNullable().defaultTo(0); // overrides default_availability for this date
    t.primary(["campaign_id", "discord_id", "date_utc"]);
    t.foreign(["campaign_id", "discord_id"])
      .references(["campaign_id", "discord_id"])
      .inTable("campaign_members")
      .onDelete("CASCADE");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropColumn("session_time_start");
    t.dropColumn("session_time_end");
    t.dropColumn("timezone");
  });
  // Note: down() intentionally does not restore the hourly-shaped tables —
  // this migration is not meant to be rolled back once real availability
  // data exists under the new shape.
}
