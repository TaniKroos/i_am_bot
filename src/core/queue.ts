import { getDb } from "./db.js";

export interface Task {
  id: number;
  agent: string;
  kind: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueOptions {
  priority?: number;
  /** Run no earlier than this epoch ms. Defaults to now. */
  runAt?: number;
  /** A queued/running task with the same key is not duplicated. */
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Durable task queue in SQLite: survives crashes and restarts. */
export function enqueue(agent: string, kind: string, payload: unknown, opts: EnqueueOptions = {}): boolean {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `INSERT INTO tasks (agent, kind, payload, priority, run_at, max_attempts, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status = 'queued', run_at = excluded.run_at, payload = excluded.payload,
         attempts = 0, updated_at = excluded.updated_at
       WHERE tasks.status IN ('done', 'failed')`,
    )
    .run(agent, kind, JSON.stringify(payload), opts.priority ?? 0, opts.runAt ?? now, opts.maxAttempts ?? 3, opts.dedupeKey ?? null, now, now);
  return res.changes > 0;
}

/** Atomically claim the next ready task for an agent, optionally limited to some kinds. */
export function claim(agent: string, kinds?: string[]): Task | undefined {
  const d = getDb();
  return d.transaction(() => {
    const filter = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const row = d
      .prepare(
        `SELECT * FROM tasks WHERE status = 'queued' AND agent = ? AND run_at <= ? ${filter}
         ORDER BY priority DESC, run_at ASC LIMIT 1`,
      )
      .get(agent, Date.now(), ...(kinds ?? [])) as any;
    if (!row) return undefined;
    d.prepare("UPDATE tasks SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(Date.now(), row.id);
    return {
      id: row.id,
      agent: row.agent,
      kind: row.kind,
      payload: JSON.parse(row.payload),
      attempts: row.attempts + 1,
      maxAttempts: row.max_attempts,
    };
  })();
}

export function complete(id: number): void {
  getDb().prepare("UPDATE tasks SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Retry with exponential backoff until max_attempts, then mark failed. */
export function fail(task: Task, error: string): void {
  const now = Date.now();
  if (task.attempts >= task.maxAttempts) {
    getDb().prepare("UPDATE tasks SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(error, now, task.id);
  } else {
    const backoff = 30_000 * 2 ** (task.attempts - 1);
    getDb()
      .prepare("UPDATE tasks SET status = 'queued', last_error = ?, run_at = ?, updated_at = ? WHERE id = ?")
      .run(error, now + backoff, now, task.id);
  }
}

/** Tasks left 'running' by a crashed process go back to the queue. */
export function recoverStale(olderThanMs = 10 * 60_000): number {
  return getDb()
    .prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ?")
    .run(Date.now(), Date.now() - olderThanMs).changes;
}
