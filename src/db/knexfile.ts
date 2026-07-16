import type { Knex } from "knex";
import type { AppConfig } from "../types/config.js";

// Minimal shape we need from mysql2's typeCast field callback — avoided a
// direct type import since mysql2's package.json restricts deep subpath
// imports and the full type isn't re-exported from the package root.
interface TypeCastField {
  type: string;
  length: number;
  string: (encoding?: string) => string | null;
}
type TypeCastNext = () => unknown;

export function buildKnexConfig(cfg: AppConfig): Knex.Config {
  return {
    client: "mysql2",
    connection: {
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: cfg.db.database,
      typeCast: function (field: TypeCastField, next: TypeCastNext) {
        // Return TINYINT(1) as boolean instead of 0/1, matches MariaDB's BOOLEAN alias.
        if (field.type === "TINY" && field.length === 1) {
          return field.string() === "1";
        }
        return next();
      },
    },
    pool: { min: 1, max: 10 },
    migrations: {
      directory: "./migrations",
      tableName: "knex_migrations",
      extension: "ts",
    },
  };
}
