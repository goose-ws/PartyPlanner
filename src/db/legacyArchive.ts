import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

// Table names unique to the legacy schema. 'campaigns' also exists in the new
// schema (different columns entirely), so we don't key off it directly —
// 'players' is the reliable fingerprint since the new schema has no such table.
const LEGACY_TABLES = ["audit_log", "campaigns", "players", "polls", "responses"] as const;
const FINGERPRINT_TABLE = "players";

const EXPORT_DIR = process.env.LEGACY_EXPORT_DIR ?? "/app/data/legacy-exports";

async function tableExists(knex: Knex, tableName: string): Promise<boolean> {
  const row = await knex("information_schema.tables")
    .where({ table_schema: knex.client.config.connection.database, table_name: tableName })
    .first();
  return !!row;
}

/**
 * If the legacy schema is present and hasn't already been archived, this:
 *   1. Dumps every legacy table to a timestamped JSON file (human-inspectable backup).
 *   2. Renames each legacy table to `legacy_<name>` so the new migrations can
 *      freely create their own `campaigns` table etc.
 *
 * Idempotent: once renamed, `players` no longer exists under its original
 * name, so subsequent boots skip straight past this.
 */
export async function archiveLegacyDataIfPresent(knex: Knex): Promise<void> {
  const isLegacyPresent = await tableExists(knex, FINGERPRINT_TABLE);
  if (!isLegacyPresent) {
    console.log("[legacy-archive] No legacy schema detected — nothing to do.");
    return;
  }

  console.log("[legacy-archive] Legacy schema detected. Archiving before running new migrations...");

  const presentTables: string[] = [];
  for (const name of LEGACY_TABLES) {
    if (await tableExists(knex, name)) presentTables.push(name);
  }

  // 1. JSON export first, while tables still have their original names.
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportPath = path.join(EXPORT_DIR, `legacy-export-${timestamp}.json`);

  const snapshot: Record<string, unknown[]> = {};
  for (const name of presentTables) {
    snapshot[name] = await knex(name).select("*");
  }
  fs.writeFileSync(exportPath, JSON.stringify(snapshot, null, 2));
  console.log(`[legacy-archive] Wrote JSON snapshot of ${presentTables.length} table(s) to ${exportPath}`);

  // 2. Rename each table out of the way. Wrapped in a transaction so a failure
  // partway through doesn't leave some tables renamed and others not.
  await knex.transaction(async (trx) => {
    for (const name of presentTables) {
      const legacyName = `legacy_${name}`;
      if (await tableExists(trx, legacyName)) {
        console.warn(`[legacy-archive] ${legacyName} already exists — skipping rename of ${name} to avoid clobbering it.`);
        continue;
      }
      await trx.raw("RENAME TABLE ?? TO ??", [name, legacyName]);
      console.log(`[legacy-archive]   ${name} -> ${legacyName}`);
    }
  });

  console.log(
    "[legacy-archive] Done. Old data is preserved under legacy_* table names and in the JSON export; " +
      "it is not read by the new application."
  );
}
