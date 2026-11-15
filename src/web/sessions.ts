import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseCookie, stringifySetCookie } from "cookie";
import type { Request, Response } from "express";
import { z } from "zod";
import type { Database } from "../storage/database.js";
import { opaqueId, type User } from "../builds/model.js";

const sessionSchema = z.object({
  csrf: z.string(),
  expiresAt: z.number(),
  user: z.object({ id: z.number(), login: z.string() }).nullable(),
  receipts: z.record(
    z.string(),
    z.object({ expiresAt: z.number(), buildId: z.string().optional() }),
  ),
});
export type Session = z.infer<typeof sessionSchema> & { key: string };
export function secret() {
  return randomBytes(32).toString("base64url");
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Sessions {
  readonly name: string;
  constructor(
    private readonly db: Database,
    private readonly secure: boolean,
  ) {
    this.name = secure ? "__Host-pyra" : "pyra-local";
  }
  read(req: Request, res: Response): Session {
    const token = parseCookie(req.headers.cookie ?? "")[this.name];
    const key = token ? hash(token) : "";
    const record = key ? this.db.get("session", key, sessionSchema) : null;
    if (record && record.expiresAt > Date.now()) return { key, ...record };
    if (key) this.db.remove("session", key);
    return this.create(res, null);
  }
  private create(res: Response, user: User | null): Session {
    const token = secret();
    const session: Session = {
      key: hash(token),
      csrf: secret(),
      user,
      expiresAt: Date.now() + 8 * 3_600_000,
      receipts: {},
    };
    this.save(session);
    res.append(
      "Set-Cookie",
      stringifySetCookie({
        name: this.name,
        value: token,
        path: "/",
        secure: this.secure,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 8 * 3600,
      }),
    );
    return session;
  }
  save(session: Session) {
    const { key, ...data } = session;
    this.db.put("session", key, data);
  }
  login(res: Response, old: Session, user: User) {
    this.db.remove("session", old.key);
    return this.create(res, user);
  }
  receipt(session: Session, resource: string, buildId?: string) {
    session.receipts[resource] = {
      expiresAt: Date.now() + 30 * 60_000,
      ...(buildId ? { buildId } : {}),
    };
    this.save(session);
  }
  started(session: Session, resource: string) {
    const receipt = session.receipts[resource];
    return receipt && receipt.expiresAt > Date.now() ? receipt : null;
  }
  confirmation(session: Session, path: string, sha: string) {
    const id = opaqueId("confirm");
    this.db.put("confirmation", id, {
      session: session.key,
      path,
      sha,
      expiresAt: Date.now() + 30 * 60_000,
    });
    return id;
  }
  verifyConfirmation(id: string, session: Session, path: string, sha: string) {
    const row = this.db.get(
      "confirmation",
      id,
      z.object({
        session: z.string(),
        path: z.string(),
        sha: z.string(),
        expiresAt: z.number(),
      }),
    );
    return (
      row &&
      row.expiresAt > Date.now() &&
      row.session === session.key &&
      row.path === path &&
      row.sha === sha
    );
  }
  revoke(userId: number) {
    this.db.sql
      .prepare(
        `DELETE FROM records WHERE kind='session'
      AND json_extract(data,'$.user.id')=?`,
      )
      .run(userId);
  }
}
