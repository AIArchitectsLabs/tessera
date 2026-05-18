import type { Database } from "bun:sqlite";

export function configureSidecarSqlite(db: Database, dbPath: string): void {
  db.exec("PRAGMA busy_timeout = 5000");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
}
