import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaign_members", (t) => {
    // DM/root-only per-member toggle: when set, this member's availability
    // is ignored entirely by the scoring engine (score sum, DM veto, and
    // the min-players headcount below) — for a flaky player whose
    // responses shouldn't move the needle, without removing them outright.
    t.boolean("excluded_from_scoring").notNullable().defaultTo(false);
  });

  await knex.schema.alterTable("campaigns", (t) => {
    // 0 = no minimum enforced. Counts non-excluded Players (not DMs) with
    // weight > 0 on a given date; dates under this threshold score 0,
    // mirroring how a DM veto works.
    t.integer("min_players_required").notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropColumn("min_players_required");
  });
  await knex.schema.alterTable("campaign_members", (t) => {
    t.dropColumn("excluded_from_scoring");
  });
}
