import type { DB, Migration } from "./db.js";
import type { EnqueueOptions } from "./queue.js";

/** What every agent gets from the runtime. */
export interface AgentContext {
  db: DB;
  agentId: string;
  enqueue(kind: string, payload: unknown, opts?: EnqueueOptions): boolean;
  log(type: string, data?: unknown): void;
  /** Ask the owner something (web app / Telegram later). Returns a request id. */
  notify(message: string, data?: unknown): void;
}

export interface Automation {
  id: string;
  everyMs: number;
  run(ctx: AgentContext): Promise<void> | void;
}

export type TaskHandler = (payload: any, ctx: AgentContext) => Promise<void>;

/**
 * An agent is a plugin: its own tables, recurring automations and task handlers.
 * Jobs is the first one; later agents (X digest, inbox, coding, ...) use the same shape.
 */
export interface Agent {
  id: string;
  name: string;
  description: string;
  migrations?: Migration[];
  automations?: Automation[];
  handlers: Record<string, TaskHandler>;
  /** Max tasks of each kind running at once (default 1). */
  concurrency?: Record<string, number>;
}
