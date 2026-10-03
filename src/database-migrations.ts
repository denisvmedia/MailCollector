import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import Database from "better-sqlite3";
import { LegacyDatabaseMigration } from "./legacy-database-migration.js";

export function migrateDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    // SQLite requires this outside the transaction when rebuilding messages.
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      const hasHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
      const adoption = hasHistory ? db.prepare("SELECT name FROM schema_migrations WHERE version = 3").get() as { name: string } | undefined : undefined;
      if (adoption) {
        if (adoption.name !== "legacy_schema_adoption") throw new Error("Schema version 3 already belongs to another migration");
        return;
      }
      new LegacyDatabaseMigration(db).run();
      if ((db.pragma("foreign_key_check") as unknown[]).length) {
        throw new Error("Legacy database upgrade left invalid foreign keys");
      }
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (3, 'legacy_schema_adoption')").run();
    }).immediate();
  } finally {
    db.close();
  }

  // Close the application connection before the migration process opens SQLite.
  // Keep the old ledger intact: its version/name format is not Ptah's format.
  const databaseURL = pathToFileURL(path.resolve(databasePath)).href.replace(/^file:/, "sqlite:");
  execFileSync(process.env.PTAH_BIN || "ptah", [
    "migrations", "up",
    "--db-url", databaseURL,
    "--migrations-dir", fileURLToPath(new URL("../migrations/", import.meta.url)),
    "--migrations-table", "ptah_schema_migrations",
    "--tx-mode", "file",
    "--verify-sum"
  ], { stdio: ["ignore", "pipe", "pipe"] });
}
