import type { Knex } from "knex";

/**
 * default_availability/specific_availability previously required a
 * campaign_members row to exist for (campaign_id, discord_id) — but root
 * bypasses membership checks everywhere else, so root hit a foreign-key
 * crash the moment they tried to set their own availability on a campaign
 * they created but hadn't formally joined. Availability data should only
 * need the campaign and the user to exist, not campaign membership.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("default_availability", (t) => {
    t.dropForeign(["campaign_id", "discord_id"]);
    t.foreign("campaign_id").references("campaigns.id").onDelete("CASCADE");
    t.foreign("discord_id").references("users.discord_id").onDelete("CASCADE");
  });

  await knex.schema.alterTable("specific_availability", (t) => {
    t.dropForeign(["campaign_id", "discord_id"]);
    t.foreign("campaign_id").references("campaigns.id").onDelete("CASCADE");
    t.foreign("discord_id").references("users.discord_id").onDelete("CASCADE");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("default_availability", (t) => {
    t.dropForeign(["campaign_id"]);
    t.dropForeign(["discord_id"]);
    t.foreign(["campaign_id", "discord_id"]).references(["campaign_id", "discord_id"]).inTable("campaign_members").onDelete("CASCADE");
  });
  await knex.schema.alterTable("specific_availability", (t) => {
    t.dropForeign(["campaign_id"]);
    t.dropForeign(["discord_id"]);
    t.foreign(["campaign_id", "discord_id"]).references(["campaign_id", "discord_id"]).inTable("campaign_members").onDelete("CASCADE");
  });
}
