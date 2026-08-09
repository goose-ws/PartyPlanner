import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("sessions", (t) => {
    t.unique(["campaign_id", "session_number"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("sessions", (t) => {
    t.dropUnique(["campaign_id", "session_number"]);
  });
}
