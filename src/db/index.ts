import knexFactory, { type Knex } from "knex";
import { buildKnexConfig } from "./knexfile.js";
import type { AppConfig } from "../types/config.js";

let _db: Knex | null = null;

export function initDb(cfg: AppConfig): Knex {
  if (_db) return _db;
  _db = knexFactory(buildKnexConfig(cfg));
  return _db;
}

export function db(): Knex {
  if (!_db) throw new Error("Database not initialized — call initDb(config) first.");
  return _db;
}
