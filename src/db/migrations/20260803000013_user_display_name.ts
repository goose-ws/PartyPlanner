import type { Knex } from "knex";

/**
 * Discord distinguishes the login-handle `username` from the friendlier
 * `global_name` ("display name") shown throughout Discord's own UI and in
 * message mentions. We want the web UI to show that same display name
 * instead of the raw handle. Backfilled to the existing username for
 * current rows; kept in sync on every future login (see routes/auth.ts).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("users", (t) => {
    t.string("global_name", 255).nullable();
  });
  await knex("users").update({ global_name: knex.ref("username") });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("users", (t) => {
    t.dropColumn("global_name");
  });
}
