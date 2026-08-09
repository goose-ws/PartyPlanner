import { loadConfig } from "../config.js";
import { isDbConfigured } from "../types/config.js";
import { initDb } from "./index.js";
import { archiveLegacyDataIfPresent } from "./legacyArchive.js";

/**
 * Runs all pending migrations, then seeds the initial root user if
 * INITIAL_ROOT_DISCORD_ID is configured and that user doesn't have the
 * 'root' role yet (e.g. they haven't logged in via Discord before).
 *
 * Invoked as a distinct step in the container entrypoint, BEFORE the web
 * server starts listening — see Dockerfile / entrypoint.sh. If DB config
 * isn't set up yet (first-run setup wizard hasn't been completed), this
 * exits cleanly rather than failing — the server itself will boot in
 * setup-only mode instead. Root-user seeding requires DB config too, since
 * it can't happen without a database to write to.
 */
async function main() {
  const cfg = loadConfig();

  if (!isDbConfigured(cfg)) {
    console.log("[migrate] Database not configured yet — skipping migrations. Complete first-run setup, then restart.");
    return;
  }

  const knex = initDb(cfg);

  console.log("[migrate] Checking database connectivity...");
  await knex.raw("SELECT 1");

  await archiveLegacyDataIfPresent(knex);

  console.log("[migrate] Running migrations...");
  const [batch, log] = await knex.migrate.latest();
  if (log.length === 0) {
    console.log("[migrate] Already up to date.");
  } else {
    console.log(`[migrate] Batch ${batch} ran ${log.length} migration(s):`);
    for (const m of log) console.log(`  - ${m}`);
  }

  if (cfg.discord.rootDiscordId) {
    const existing = await knex("users").where({ discord_id: cfg.discord.rootDiscordId }).first();
    if (existing) {
      if (existing.global_role !== "root") {
        await knex("users").where({ discord_id: cfg.discord.rootDiscordId }).update({ global_role: "root" });
        console.log(`[migrate] Promoted existing user ${cfg.discord.rootDiscordId} to root.`);
      }
    } else {
      // Placeholder row — username/avatar get filled in for real on their first Discord login.
      await knex("users").insert({
        discord_id: cfg.discord.rootDiscordId,
        username: "(pending first login)",
        global_role: "root",
      });
      console.log(`[migrate] Seeded root user placeholder for ${cfg.discord.rootDiscordId}.`);
    }
  }

  await knex.destroy();
  console.log("[migrate] Done.");
}

main().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exit(1);
});
