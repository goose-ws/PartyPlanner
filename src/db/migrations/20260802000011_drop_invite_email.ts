import type { Knex } from "knex";

/**
 * `campaign_invites.email` only ever existed to record that an invite had
 * been sent via SMTP (see migration 20260716000002). SMTP support has been
 * removed entirely, so this column has no remaining purpose — invites are
 * always redeemed by token/link now, never by email lookup.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaign_invites", (t) => {
    t.dropColumn("email");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaign_invites", (t) => {
    t.string("email", 255).nullable();
  });
}
