import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema

    .createTable("users", (t) => {
      t.string("discord_id", 64).primary();
      t.string("username", 100).notNullable();
      t.string("avatar_hash", 100).nullable();
      t.enum("global_role", ["root", "user"], {
        useNative: true,
        enumName: "users_global_role_enum",
      }).notNullable().defaultTo("user");
      t.string("timezone", 50).notNullable().defaultTo("UTC");
      // Stored encrypted at the application layer before insert; see auth/discord.ts.
      t.text("discord_refresh_token").nullable();
      t.timestamp("created_at").defaultTo(knex.fn.now());
    })

    .createTable("user_sessions", (t) => {
      t.string("sid", 255).primary();
      t.string("discord_id", 64).notNullable();
      t.dateTime("expires").notNullable();
      t.foreign("discord_id").references("users.discord_id").onDelete("CASCADE");
      t.index("expires");
    })

    .createTable("campaigns", (t) => {
      t.string("id", 36).primary(); // UUID
      t.string("name", 100).notNullable();
      t.date("start_date").notNullable(); // cadence anchor
      t.enum("cadence_type", ["bi-weekly", "custom_interval", "weekly_static"], {
        useNative: true,
        enumName: "campaigns_cadence_type_enum",
      }).notNullable().defaultTo("bi-weekly");
      t.integer("interval_weeks").notNullable().defaultTo(2);
      t.integer("sessions_per_interval").notNullable().defaultTo(1);
      t.integer("blackout_days_after_lock").notNullable().defaultTo(7);
      t.enum("granularity", ["blocks", "hourly"], {
        useNative: true,
        enumName: "campaigns_granularity_enum",
      }).notNullable().defaultTo("hourly");
      t.integer("last_session_number").notNullable().defaultTo(0);
      t.timestamp("created_at").defaultTo(knex.fn.now());
    })

    .createTable("campaign_members", (t) => {
      t.string("campaign_id", 36).notNullable();
      t.string("discord_id", 64).notNullable();
      t.enum("role", ["DM", "Player"], {
        useNative: true,
        enumName: "campaign_members_role_enum",
      }).notNullable().defaultTo("Player");
      t.primary(["campaign_id", "discord_id"]);
      t.foreign("campaign_id").references("campaigns.id").onDelete("CASCADE");
      t.foreign("discord_id").references("users.discord_id").onDelete("CASCADE");
    })

    .createTable("default_availability", (t) => {
      t.string("campaign_id", 36).notNullable();
      t.string("discord_id", 64).notNullable();
      t.integer("day_of_week").notNullable(); // 0 (Sun) - 6 (Sat)
      t.time("start_time_utc").notNullable();
      t.time("end_time_utc").notNullable();
      t.integer("weight").notNullable().defaultTo(0); // 0..3
      t.primary(["campaign_id", "discord_id", "day_of_week", "start_time_utc"]);
      t.foreign(["campaign_id", "discord_id"])
        .references(["campaign_id", "discord_id"])
        .inTable("campaign_members")
        .onDelete("CASCADE");
    })

    .createTable("specific_availability", (t) => {
      t.string("campaign_id", 36).notNullable();
      t.string("discord_id", 64).notNullable();
      t.date("date_utc").notNullable();
      t.time("start_time_utc").notNullable();
      t.time("end_time_utc").notNullable();
      t.integer("weight").notNullable().defaultTo(0);
      t.primary(["campaign_id", "discord_id", "date_utc", "start_time_utc"]);
      t.foreign(["campaign_id", "discord_id"])
        .references(["campaign_id", "discord_id"])
        .inTable("campaign_members")
        .onDelete("CASCADE");
    })

    .createTable("sessions", (t) => {
      t.string("id", 36).primary(); // UUID
      t.string("campaign_id", 36).notNullable();
      t.integer("session_number").nullable(); // null until locked; released on cancel
      t.dateTime("scheduled_start_utc").notNullable();
      t.dateTime("scheduled_end_utc").notNullable();
      t.enum("status", ["scheduled", "completed", "skipped", "cancelled"], {
        useNative: true,
        enumName: "sessions_status_enum",
      }).notNullable().defaultTo("scheduled");
      t.string("notes", 255).nullable();
      t.foreign("campaign_id").references("campaigns.id").onDelete("CASCADE");
      t.index(["campaign_id", "status"]);
    })

    .createTable("session_absences", (t) => {
      t.string("session_id", 36).notNullable();
      t.string("discord_id", 64).notNullable();
      t.boolean("excused").notNullable().defaultTo(true);
      t.primary(["session_id", "discord_id"]);
      t.foreign("session_id").references("sessions.id").onDelete("CASCADE");
      t.foreign("discord_id").references("users.discord_id").onDelete("CASCADE");
    });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("session_absences")
    .dropTableIfExists("sessions")
    .dropTableIfExists("specific_availability")
    .dropTableIfExists("default_availability")
    .dropTableIfExists("campaign_members")
    .dropTableIfExists("campaigns")
    .dropTableIfExists("user_sessions")
    .dropTableIfExists("users");
}
