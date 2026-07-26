import fs from "node:fs";
import path from "node:path";
import type { StoredConfig } from "./types/config.js";

const CONFIG_PATH = process.env.CONFIG_PATH ?? "/app/data/config.json";

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readStoredConfig(): Partial<StoredConfig> {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    delete parsed._warning; // informational only, not a real config field
    return parsed as Partial<StoredConfig>;
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read/parse config at ${CONFIG_PATH}: ${err.message}`);
  }
}

/** Deep-merges `patch` into the existing stored config and writes it back. Owner-read-only permissions, since this file can contain secrets. */
export function writeStoredConfig(patch: Partial<StoredConfig>): Partial<StoredConfig> {
  const current = readStoredConfig();
  const merged = deepMerge(current, patch);

  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const withWarning = {
    _warning: "This file can contain secrets (DB password, Discord client secret, session keys). Do not share it or commit it to version control.",
    ...merged,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(withWarning, null, 2) + "\n", { mode: 0o600 });
  return merged;
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Partial<T>): T {
  const result: any = { ...base };
  for (const key of Object.keys(patch)) {
    const patchVal = (patch as any)[key];
    if (patchVal && typeof patchVal === "object" && !Array.isArray(patchVal)) {
      result[key] = deepMerge(result[key] ?? {}, patchVal);
    } else {
      result[key] = patchVal;
    }
  }
  return result;
}
