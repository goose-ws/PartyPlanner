import type { Knex } from "knex";

/**
 * Tracks an explicit "I've checked my availability for this window" flag,
 * separate from the actual weight/flag responses. Scoped per (member,
 * block) rather than per-campaign, so it can't be set once and forgotten —
 * see invalidateOpenBlockConfirmations in src/scheduling/blockConfirmations.ts,
 * which silently clears it whenever that member's availability changes for
 * a still-open block.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("block_confirmations", (t) => {
    t.string("id", 36).primary(); // UUID
    t.string("campaign_id", 36).notNullable();
    t.string("discord_id", 64).notNullable();
    t.date("block_start").notNullable(); // the block's first calendar day — see blockRange() in candidateEngine.ts
    t.timestamp("confirmed_at").notNullable().defaultTo(knex.fn.now());
    t.foreign(["campaign_id", "discord_id"]).references(["campaign_id", "discord_id"]).inTable("campaign_members").onDelete("CASCADE");
    t.unique(["campaign_id", "discord_id", "block_start"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("block_confirmations");
}
