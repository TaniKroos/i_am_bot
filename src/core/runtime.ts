import type { Agent, AgentContext } from "./agent.js";
import { getDb, logEvent, migrate } from "./db.js";
import { claim, complete, enqueue, fail, recoverStale, type Task } from "./queue.js";

/** Runs agents: schedules their automations and executes queued tasks with per-kind concurrency. */
export class Runtime {
  private agents = new Map<string, Agent>();
  private running = new Map<string, number>(); // "agent:kind" -> in-flight count
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

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

  stop(): void {
    this.stopped = true;
    this.timers.forEach(clearInterval);
  }

  /** Run tasks until the queue has nothing ready (used by one-shot CLI commands). */
  async drain(): Promise<void> {
    for (;;) {
      this.pump();
      await new Promise((r) => setTimeout(r, 100));
      const inflight = [...this.running.values()].reduce((a, b) => a + b, 0);
      const ready = getDb().prepare("SELECT COUNT(*) FROM tasks WHERE status='queued' AND run_at <= ?").pluck().get(Date.now()) as number;
      if (!inflight && !ready) return;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    for (const agent of this.agents.values()) {
      for (const kind of Object.keys(agent.handlers)) {
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
      fail(task, e instanceof Error ? e.message : String(e));
      logEvent(agent.id, "task_error", { kind: task.kind, id: task.id, error: String(e) });
    }
  }
}
