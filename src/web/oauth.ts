import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../storage/database.js";
import type { Session } from "./sessions.js";
import { hash, secret } from "./sessions.js";
import type { User } from "../builds/model.js";

const flowSchema = z.object({
  session: z.string(),
  verifier: z.string(),
  path: z.string(),
  expiresAt: z.number(),
});

export interface OAuthIdentity {
  exchange(code: string, verifier: string): Promise<User>;
}

/** GitHub's documented web flow, including PKCE which oauth-app 8 does not forward.
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 * Tokens are used once to read identity, then discarded; only user ID/login are persisted.
 */
export class GitHubOAuth implements OAuthIdentity {
  constructor(private readonly config: Config) {}
  async exchange(code: string, verifier: string): Promise<User> {
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.GITHUB_CLIENT_ID,
        client_secret: this.config.GITHUB_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        redirect_uri: `${this.config.publicUrl}/builder/oauth/callback`,
      }),
    });
    if (!response.ok) throw new Error("GitHub authorization failed");
    const token = z
      .object({ access_token: z.string().min(1) })
      .parse(await response.json()).access_token;
    const identity = await fetch("https://api.github.com/user", {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    if (!identity.ok) throw new Error("GitHub identity could not be confirmed");
    return z
      .object({ id: z.int().positive(), login: z.string().regex(/^[A-Za-z0-9-]+$/) })
      .parse(await identity.json());
  }
}

export class OAuthFlows {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly identity: OAuthIdentity,
  ) {}
  start(session: Session, path: string, switchAccount = false): string {
    if (
      !/^\/builder\/rebuild\/[\w.-]+\/[\w.-]+\/[1-9][0-9]*\/(latest|[a-f0-9]{40})$/.test(
        path,
      )
    ) {
      throw new Error("Invalid OAuth return path");
    }
    const state = secret(),
      verifier = secret();
    this.db.put("oauth", hash(state), {
      session: session.key,
      verifier,
      path,
      expiresAt: Date.now() + 600_000,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.config.GITHUB_CLIENT_ID);
    url.searchParams.set(
      "redirect_uri",
      `${this.config.publicUrl}/builder/oauth/callback`,
    );
    url.searchParams.set("state", state);
    url.searchParams.set(
      "code_challenge",
      Buffer.from(hash(verifier), "hex").toString("base64url"),
    );
    url.searchParams.set("code_challenge_method", "S256");
    if (switchAccount) url.searchParams.set("prompt", "select_account");
    return url.toString();
  }
  async finish(session: Session, state: string, code: string) {
    const flow = this.db.transaction(() => {
      const value = this.db.get("oauth", hash(state), flowSchema);
      if (!value || value.session !== session.key || value.expiresAt < Date.now()) {
        throw new Error("Invalid or expired authorization state");
      }
      this.db.remove("oauth", hash(state));
      return value;
    });
    const user = await this.identity.exchange(code, flow.verifier);
    return { user, path: flow.path };
  }
}
