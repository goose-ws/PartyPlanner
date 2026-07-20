import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.string("slug", 80).nullable(); // unique enforced by a separate index below, added after backfill
  });

  // Backfill existing rows with a slug derived from their name, so nothing
  // breaks for campaigns created before slugs existed.
  const campaigns: Array<{ id: string; name: string }> = await knex("campaigns").select("id", "name");
  const used = new Set<string>();
  for (const c of campaigns) {
    let base = c.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    if (!base) base = "campaign";
    let slug = base;
    let n = 2;
    while (used.has(slug)) {
      slug = `${base}-${n}`;
      n++;
    }
    used.add(slug);
    await knex("campaigns").where({ id: c.id }).update({ slug });
  }

  await knex.schema.alterTable("campaigns", (t) => {
    t.string("slug", 80).notNullable().alter();
    t.unique("slug");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("campaigns", (t) => {
    t.dropUnique(["slug"]);
    t.dropColumn("slug");
  });
}
