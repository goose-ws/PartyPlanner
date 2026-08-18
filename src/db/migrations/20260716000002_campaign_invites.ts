import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("campaign_invites", (t) => {
    t.string("token", 64).primary();
    t.string("campaign_id", 36).notNullable();
    t.string("created_by_discord_id", 64).notNullable();

    // The role a redeemer is granted. DMs may only ever create 'Player' invites;
    // only root can mint a 'DM' invite — enforced in the route handler, not the DB.
    t.enum("role", ["DM", "Player"], {
      useNative: true,
      enumName: "campaign_invites_role_enum",
    }).notNullable().defaultTo("Player");

    // Optional — set if the invite was sent via SMTP. Purely informational
    // (redemption is by token, not email; anyone with the link can use it
    // unless max_uses is reached).
    t.string("email", 255).nullable();

    t.integer("max_uses").nullable(); // NULL = unlimited, until expiry/revocation
    t.integer("uses").notNullable().defaultTo(0);
    t.dateTime("expires_at").nullable();
    t.dateTime("revoked_at").nullable();
    t.timestamp("created_at").defaultTo(knex.fn.now());

    t.foreign("campaign_id").references("campaigns.id").onDelete("CASCADE");
    t.foreign("created_by_discord_id").references("users.discord_id");
    t.index(["campaign_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("campaign_invites");
}
