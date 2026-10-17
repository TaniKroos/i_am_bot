import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { PROFILE_DIR } from "../config.js";

/**
 * Google sign-in for the owner's Gmail, read-only.
 * Desktop-app OAuth with a loopback redirect and PKCE; the refresh token lives in the macOS Keychain.
 */

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CLIENT_FILE = join(PROFILE_DIR, "google-oauth-client.json");
const KEYCHAIN_SERVICE = "grokbot-gmail";

interface Client {
  client_id: string;
  client_secret: string;
}

function loadClient(): Client {
  if (!existsSync(CLIENT_FILE)) throw new Error(`Missing ${CLIENT_FILE} (download it from Google Cloud → Clients → Desktop app)`);
  const j = JSON.parse(readFileSync(CLIENT_FILE, "utf8"));
  const c = j.installed ?? j.web;
  if (!c?.client_id) throw new Error("google-oauth-client.json has no client_id");
  return c;
}

const keychain = {
  get(): string | null {
    try {
      return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  },
  set(account: string, secret: string): void {
    execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", secret]);
  },
};

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Opens Google's consent page in the default browser and stores the refresh token. */
export async function gmailLogin(): Promise<{ email: string; scope: string }> {
  const client = loadClient();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") return void res.writeHead(404).end();
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" }).end(
        ok ? "<h2>grokBot: Gmail connected (read-only). You can close this tab.</h2>" : "<h2>Sign-in failed or was cancelled.</h2>",
      );
      server.close();
      if (ok) resolve({ code: url.searchParams.get("code")!, redirectUri });
      else reject(new Error(url.searchParams.get("error") ?? "state mismatch"));
    });
    let redirectUri = "";
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      redirectUri = `http://127.0.0.1:${port}`;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [k, v] of Object.entries({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GMAIL_SCOPE,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        login_hint: "tanishsaini26@gmail.com",
      }))
        auth.searchParams.set(k, v);
      console.log(`Opening Google sign-in…\nIf no browser opens, visit:\n${auth}`);
      spawn("open", [auth.toString()], { stdio: "ignore", detached: true }).unref();
    });
    setTimeout(() => (server.close(), reject(new Error("sign-in timed out (5 min)"))), 5 * 60_000).unref();
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const tok = (await tokenRes.json()) as { refresh_token?: string; access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!tok.refresh_token) throw new Error(`token exchange failed: ${tok.error ?? ""} ${tok.error_description ?? "no refresh token"}`);
  if (tok.scope?.split(" ").some((s) => s !== GMAIL_SCOPE)) throw new Error(`unexpected scopes granted: ${tok.scope}`);
  const profile = await gmailProfileWith(tok.access_token!);
  keychain.set(profile.emailAddress, tok.refresh_token);
  return { email: profile.emailAddress, scope: tok.scope ?? GMAIL_SCOPE };
}

let cached: { token: string; expires: number } | undefined;

export async function gmailAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expires - 60_000) return cached.token;
  const refresh = keychain.get();
  if (!refresh) throw new Error("Gmail not connected: run `npm run bot -- gmail-login`");
  const client = loadClient();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refresh, client_id: client.client_id, client_secret: client.client_secret, grant_type: "refresh_token" }),
  });
  const tok = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!tok.access_token) throw new Error(`Gmail token refresh failed: ${tok.error} (re-run gmail-login)`);
  cached = { token: tok.access_token, expires: Date.now() + (tok.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function gmailProfileWith(token: string): Promise<{ emailAddress: string; messagesTotal: number }> {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Gmail profile: ${res.status} ${await res.text()}`);
  return (await res.json()) as { emailAddress: string; messagesTotal: number };
}

export async function gmailProfile() {
  return gmailProfileWith(await gmailAccessToken());
}
