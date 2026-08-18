import type { Knex } from "knex";

/**
 * These flags only make sense on a specific date (not a recurring weekly
 * default) — "joining late" or "dropping early" is inherently a one-off
 * situational thing, not a pattern. Each deducts 0.5 from that member's
 * contribution to the date's score (floored at 0), applied in the scoring
 * engine, not stored as a pre-computed value.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("specific_availability", (t) => {
    t.boolean("joining_late").notNullable().defaultTo(false);
    t.boolean("dropping_early").notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("specific_availability", (t) => {
    t.dropColumn("joining_late");
    t.dropColumn("dropping_early");
  });
}
