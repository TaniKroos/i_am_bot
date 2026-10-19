import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { DATA_DIR, ROOT } from "./config.js";

/**
 * Runs `bot run` under launchd only when the owner starts it: `bot start` / `bot stop`.
 * While started it restarts after a crash; it never starts at login (the plist lives in data/, not ~/Library/LaunchAgents).
 * The bot itself holds a caffeinate assertion, so the Mac stays awake while it runs (the display may still sleep).
 */

const LABEL = "com.grokbot.agent";
const PLIST = join(DATA_DIR, `${LABEL}.plist`);
/** Where an older version installed it to start at login; removed on start/stop. */
const LOGIN_PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG = join(DATA_DIR, "logs", "bot.log");
const target = () => `gui/${userInfo().uid}`;

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Label, `bot <command>` and environment shared by both launchd jobs. */
function plistHead(label: string, command: string): string {
  const node = process.execPath; // the Node that runs this command (Node 24 via nvm)
  const path = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const args = [node, join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "src", "cli.ts"), command];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
  </dict>`;
}

function plist(): string {
  return `${plistHead(LABEL, "run")}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

const launchctl = (...a: string[]) => {
  try {
    return execFileSync("launchctl", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    return String(e.stderr ?? e.message);
  }
};

const loaded = () => !/could not find|not find service/i.test(launchctl("print", `${target()}/${LABEL}`));

export function startService(): string {
  rmSync(LOGIN_PLIST, { force: true });
  mkdirSync(dirname(LOG), { recursive: true });
  if (loaded()) return `Already running.\n${serviceStatus()}`;
  writeFileSync(PLIST, plist());
  launchctl("bootstrap", target(), PLIST);
  return `Started. It runs until you stop it (npm run bot -- stop), log out or restart the Mac; it does not start at login.\nLogs: ${LOG}\n${serviceStatus()}`;
}

export function stopService(): string {
  rmSync(LOGIN_PLIST, { force: true });
  if (!loaded()) return "Not running.";
  launchctl("bootout", `${target()}/${LABEL}`);
  return "Stopped. No polling, no Claude usage, and the Mac can sleep normally.";
}

export function restartService(): string {
  if (!loaded()) return startService();
  launchctl("kickstart", "-k", `${target()}/${LABEL}`);
  return serviceStatus();
}

export function serviceStatus(): string {
  if (!loaded()) return "Not running (start it with: npm run bot -- start).";
  const info = launchctl("print", `${target()}/${LABEL}`);
  const state = info.match(/state = (\S+)/)?.[1] ?? "not loaded";
  const pid = info.match(/\bpid = (\d+)/)?.[1];
  const tail = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").slice(-5).join("\n") : "";
  return `Service: ${state}${pid ? ` (pid ${pid})` : ""}\nLog tail:\n${tail}`;
}

/**
 * Scheduled `bot sweep` at fixed hours (default 9:00 and 18:00). Unlike the service this one is installed in
 * ~/Library/LaunchAgents so it survives a restart, but it only ever runs at those hours (no RunAtLoad).
 * If the Mac is asleep at that hour, launchd runs the missed sweep once on wake.
 */
const SWEEP_LABEL = "com.grokbot.sweep";
const SWEEP_PLIST = join(homedir(), "Library", "LaunchAgents", `${SWEEP_LABEL}.plist`);
const SWEEP_LOG = join(DATA_DIR, "logs", "sweep.log");

export function scheduleSweep(hours: number[]): string {
  mkdirSync(dirname(SWEEP_LOG), { recursive: true });
  mkdirSync(dirname(SWEEP_PLIST), { recursive: true });
  launchctl("bootout", `${target()}/${SWEEP_LABEL}`);
  writeFileSync(
    SWEEP_PLIST,
    `${plistHead(SWEEP_LABEL, "sweep")}
  <key>StartCalendarInterval</key>
  <array>
${hours.map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>0</integer></dict>`).join("\n")}
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(SWEEP_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(SWEEP_LOG)}</string>
</dict>
</plist>
`,
  );
  const err = launchctl("bootstrap", target(), SWEEP_PLIST);
  return `${err.trim() ? `launchctl: ${err.trim()}\n` : ""}Sweep scheduled daily at ${hours.map((h) => `${h}:00`).join(" and ")}. Logs: ${SWEEP_LOG}\nRemove with: npm run bot -- unschedule`;
}

export function unscheduleSweep(): string {
  launchctl("bootout", `${target()}/${SWEEP_LABEL}`);
  rmSync(SWEEP_PLIST, { force: true });
  return "Sweep schedule removed.";
}

export function sweepSchedule(): string | null {
  if (!existsSync(SWEEP_PLIST)) return null;
  const hours = [...readFileSync(SWEEP_PLIST, "utf8").matchAll(/<key>Hour<\/key><integer>(\d+)/g)].map((m) => `${m[1]}:00`);
  return hours.join(" and ");
}
