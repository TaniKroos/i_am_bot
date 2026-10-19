import type { Agent, AgentContext } from "./agent.js";
import { getDb, logEvent, migrate } from "./db.js";
import { claim, complete, defer, enqueue, fail, recoverStale, type Task } from "./queue.js";

/** Throw from a handler to retry later without using up an attempt. */
export class Deferred extends Error {
  constructor(message: string, readonly delayMs = 15 * 60_000) {
    super(message);
  }
}

/** Runs agents: schedules their automations and executes queued tasks with per-kind concurrency. */
export class Runtime {
  private agents = new Map<string, Agent>();
  private running = new Map<string, number>(); // "agent:kind" -> in-flight count
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /** When set, only these task kinds run (a find-only sweep must never pick up a queued application). */
  private only?: Set<string>;

  register(agent: Agent): void {
    getDb();
    if (agent.migrations) migrate(agent.migrations);
    this.agents.set(agent.id, agent);
  }

  context(agentId: string): AgentContext {
    return {
      db: getDb(),
      agentId,
      enqueue: (kind, payload, opts) => enqueue(agentId, kind, payload, opts),
      log: (type, data) => logEvent(agentId, type, data),
      notify: (message, data) => {
        logEvent(agentId, "notify", { message, data });
        console.log(`🔔 [${agentId}] ${message}`);
      },
    };
  }

  start(): void {
    const recovered = recoverStale(0);
    if (recovered) console.log(`recovered ${recovered} interrupted task(s)`);

    for (const agent of this.agents.values()) {
      for (const a of agent.automations ?? []) {
        const tick = async () => {
          try {
            await a.run(this.context(agent.id));
          } catch (e) {
            logEvent(agent.id, "automation_error", { automation: a.id, error: String(e) });
          }
        };
        void tick();
        this.timers.push(setInterval(tick, a.everyMs));
      }
    }
    this.timers.push(setInterval(() => this.pump(), 250));
  }

  /** Run only these task kinds from now on. */
  restrict(kinds: string[]): void {
    this.only = new Set(kinds);
  }

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearInterval);
  }

  /** Run tasks until the queue has nothing ready (used by one-shot CLI commands). */
  async drain(): Promise<void> {
    const kinds = this.only ? [...this.only] : null;
    const filter = kinds ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    for (;;) {
      this.pump();
      await new Promise((r) => setTimeout(r, 100));
      const inflight = [...this.running.values()].reduce((a, b) => a + b, 0);
      const ready = getDb()
        .prepare(`SELECT COUNT(*) FROM tasks WHERE status='queued' AND run_at <= ? ${filter}`)
        .pluck()
        .get(Date.now(), ...(kinds ?? [])) as number;
      if (!inflight && !ready) return;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    for (const agent of this.agents.values()) {
      for (const kind of Object.keys(agent.handlers)) {
        if (this.only && !this.only.has(kind)) continue;
        const key = `${agent.id}:${kind}`;
        const limit = agent.concurrency?.[kind] ?? 1;
        while ((this.running.get(key) ?? 0) < limit) {
          const task = claim(agent.id, [kind]);
          if (!task) break;
          this.running.set(key, (this.running.get(key) ?? 0) + 1);
          void this.execute(agent, task).finally(() => this.running.set(key, (this.running.get(key) ?? 1) - 1));
        }
      }
    }
  }

  private async execute(agent: Agent, task: Task): Promise<void> {
    try {
      await agent.handlers[task.kind](task.payload, this.context(agent.id));
      complete(task.id);
    } catch (e) {
      if (e instanceof Deferred) return defer(task, e.delayMs, e.message);
      fail(task, e instanceof Error ? e.message : String(e));
      logEvent(agent.id, "task_error", { kind: task.kind, id: task.id, error: String(e) });
    }
  }
}
