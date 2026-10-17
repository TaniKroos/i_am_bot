import Database from "better-sqlite3";
import { DB_PATH } from "./config.js";

export type DB = Database.Database;

export interface Migration {
  /** Unique, stable id, e.g. "core:001" or "jobs:001". Never rename once applied. */
  id: string;
  sql: string;
}

const coreMigrations: Migration[] = [
  {
    id: "core:001",
    sql: `
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        agent TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX events_agent_ts ON events(agent, ts);

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
        priority INTEGER NOT NULL DEFAULT 0,     -- higher runs first
        run_at INTEGER NOT NULL,                 -- epoch ms
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        dedupe_key TEXT UNIQUE,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX tasks_ready ON tasks(status, run_at, priority);

      CREATE TABLE kv (
        agent TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (agent, key)
      );
    `,
  },
];

let db: DB | undefined;

export function getDb(): DB {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    migrate(coreMigrations);
  }
  return db;
}

export function migrate(migrations: Migration[]): void {
  const d = db!;
  const applied = new Set(d.prepare("SELECT id FROM migrations").pluck().all() as string[]);
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
    })();
  }
}

export function logEvent(agent: string, type: string, data?: unknown): void {
  getDb()
    .prepare("INSERT INTO events (agent, type, data) VALUES (?, ?, ?)")
    .run(agent, type, data === undefined ? null : JSON.stringify(data));
}
