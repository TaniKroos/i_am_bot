import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Headless Claude Code as a worker ("Claude Code inside grokBot").
 * Runs `claude -p` on the owner's own login, in one working folder, with an explicit tool allowlist.
 * Anything not allowlisted is denied automatically in print mode.
 */

export interface ClaudeCodeEvent {
  type: string;
  [k: string]: unknown;
}

export interface ClaudeCodeRun {
  cwd: string;
  prompt: string;
  /** e.g. ["Read", "Write", "Edit", "Bash(pdflatex:*)"] */
  allowedTools: string[];
  /** Directories prepended to PATH for the session's shell commands. */
  extraPath?: string[];
  maxTurns?: number;
  model?: string;
  timeoutMs?: number;
  onEvent?(e: ClaudeCodeEvent): void;
}

export interface ClaudeCodeResult {
  ok: boolean;
  result: string;
  turns: number;
  durationMs: number;
  /** Reported by the CLI; on a subscription this is an API-equivalent estimate, not a charge. */
  costUsd: number | null;
  error?: string;
}

/** CLAUDE_BIN, else `claude` on PATH, else the newest binary bundled with the VS Code extension. */
export function findClaudeBinary(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  const ext = join(homedir(), ".vscode", "extensions");
  const bundled = existsSync(ext)
    ? readdirSync(ext)
        .filter((d) => d.startsWith("anthropic.claude-code-"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((d) => join(ext, d, "resources", "native-binary", "claude"))
        .filter(existsSync)
    : [];
  if (bundled.length) return bundled.at(-1)!;
  throw new Error("Claude Code binary not found; set CLAUDE_BIN");
}

export function runClaudeCode(run: ClaudeCodeRun): Promise<ClaudeCodeResult> {
  const args = [
    "-p",
    run.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--allowedTools",
    run.allowedTools.join(","),
    "--max-turns",
    String(run.maxTurns ?? 60),
    // Load only what the job needs: no MCP servers or connectors, and only the built-in tools it's allowed.
    // Cuts the fixed context resent every turn from ~40K to ~8K tokens.
    "--strict-mcp-config",
    "--tools",
    [...new Set(run.allowedTools.map((t) => t.replace(/\(.*$/, "")))].join(","),
  ];
  if (run.model) args.push("--model", run.model);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...(run.extraPath ?? []), process.env.PATH].join(":") };
  // Use the owner's Claude login, never an API key that might be lying around in the environment.
  delete env.ANTHROPIC_API_KEY;

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(findClaudeBinary(), args, { cwd: run.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let final: ClaudeCodeResult | undefined;
    const timer = setTimeout(() => child.kill("SIGTERM"), run.timeoutMs ?? 20 * 60_000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: ClaudeCodeEvent;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        run.onEvent?.(event);
        if (event.type === "result") {
          final = {
            ok: event.subtype === "success" && !event.is_error,
            result: String(event.result ?? ""),
            turns: Number(event.num_turns ?? 0),
            durationMs: Date.now() - started,
            costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
            error: event.subtype === "success" ? undefined : String(event.subtype),
          };
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(
        final ?? {
          ok: false,
          result: "",
          turns: 0,
          durationMs: Date.now() - started,
          costUsd: null,
          error: `claude exited with ${code}: ${stderr.slice(-500)}`,
        },
      );
    });
  });
}
