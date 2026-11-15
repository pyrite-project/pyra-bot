import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  buildSchema,
  fileSchema,
  pullSchema,
  opaqueId,
  buildTag,
  type Build,
  type ArtifactFile,
  type Pull,
} from "../builds/model.js";

const taskSchema = z.object({
  id: z.string(),
  type: z.string(),
  payload: z.string(),
  attempts: z.number(),
  lease_until: z.number(),
});
export type Task = z.infer<typeof taskSchema>;

/** Single-host durable records and leased jobs. Transactions never cross await boundaries. */
export class Database {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        updated INTEGER NOT NULL, PRIMARY KEY(kind,id)
      );
      CREATE INDEX IF NOT EXISTS records_pull ON records(kind,json_extract(data,'$.pullId'));
      CREATE INDEX IF NOT EXISTS records_run ON records(kind,json_extract(data,'$.runId'));
      CREATE INDEX IF NOT EXISTS records_build_file ON records(kind,json_extract(data,'$.buildId'));
      CREATE UNIQUE INDEX IF NOT EXISTS automatic_build ON records(
        json_extract(data,'$.automaticKey')
      ) WHERE kind='build' AND json_extract(data,'$.automaticKey') IS NOT NULL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, dedupe TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL, run_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(done,run_at,lease_until);
    `);
  }
  close() {
    this.sql.close();
  }

  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  get<T>(kind: string, id: string, schema: z.ZodType<T>): T | null {
    const row = this.sql
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? schema.parse(JSON.parse(String(row.data))) : null;
  }
  put(kind: string, id: string, data: object, now = Date.now()) {
    this.sql
      .prepare(
        `INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id)
      DO UPDATE SET data=excluded.data,updated=excluded.updated`,
      )
      .run(kind, id, JSON.stringify(data), now);
  }
  remove(kind: string, id: string) {
    this.sql.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  list<T>(kind: string, schema: z.ZodType<T>, pullId?: string): T[] {
    const rows =
      pullId === undefined
        ? this.sql.prepare("SELECT data FROM records WHERE kind=?").all(kind)
        : this.sql
            .prepare(
              "SELECT data FROM records WHERE kind=? AND json_extract(data,'$.pullId')=?",
            )
            .all(kind, pullId);
    return rows.map((r) => schema.parse(JSON.parse(String(r.data))));
  }
  pull(id: string) {
    return this.get("pull", id, pullSchema);
  }
  savePull(p: Pull) {
    this.put("pull", p.id, p);
  }
  pulls() {
    return this.list("pull", pullSchema);
  }
  build(id: string) {
    return this.get("build", id, buildSchema);
  }
  saveBuild(b: Build) {
    this.put("build", b.id, b);
  }
  builds(pullId?: string) {
    return this.list("build", buildSchema, pullId);
  }
  file(id: string) {
    return this.get("file", id, fileSchema);
  }
  saveFile(f: ArtifactFile) {
    this.put("file", f.id, f);
  }
  files(pullId: string, buildId?: string, attempt?: number) {
    if (buildId === undefined) return this.list("file", fileSchema, pullId);
    return this.sql
      .prepare(
        `SELECT data FROM records WHERE kind='file'
      AND json_extract(data,'$.buildId')=? AND json_extract(data,'$.attempt')=?`,
      )
      .all(buildId, attempt ?? 1)
      .map((r) => fileSchema.parse(JSON.parse(String(r.data))));
  }
  activeBuilds(pullId?: string) {
    const query = `SELECT data FROM records WHERE kind='build' AND
      json_extract(data,'$.status') IN ('queued','dispatching','dispatch_unknown','running','publishing')`;
    const rows =
      pullId === undefined
        ? this.sql.prepare(query).all()
        : this.sql.prepare(`${query} AND json_extract(data,'$.pullId')=?`).all(pullId);
    return rows.map((r) => buildSchema.parse(JSON.parse(String(r.data))));
  }
  automatic(key: string) {
    const r = this.sql
      .prepare(
        `SELECT data FROM records WHERE kind='build'
      AND json_extract(data,'$.automaticKey')=?`,
      )
      .get(key);
    return r ? buildSchema.parse(JSON.parse(String(r.data))) : null;
  }
  knownCommit(pullId: string, sha: string) {
    const r = this.sql
      .prepare(
        `SELECT data FROM records WHERE kind='build'
      AND json_extract(data,'$.pullId')=? AND json_extract(data,'$.sourceSha')=? LIMIT 1`,
      )
      .get(pullId, sha);
    return r ? buildSchema.parse(JSON.parse(String(r.data))) : null;
  }
  dailyDispatches(repositoryId: number) {
    const midnight = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    const row = this.sql
      .prepare(
        `SELECT count(*) AS n FROM records WHERE kind='build'
      AND json_extract(data,'$.repositoryId')=? AND json_extract(data,'$.dispatchedAt')>=?`,
      )
      .get(repositoryId, midnight);
    return Number(row?.n ?? 0);
  }
  allocateTag() {
    for (;;) {
      const tag = buildTag();
      const result = this.sql
        .prepare("INSERT OR IGNORE INTO records VALUES('tag',?,'{}',?)")
        .run(tag, Date.now());
      if (Number(result.changes) > 0) return tag;
    }
  }
  byRun(runId: number) {
    const row = this.sql
      .prepare(
        `SELECT data FROM records WHERE kind='build'
      AND json_extract(data,'$.runId')=? LIMIT 1`,
      )
      .get(runId);
    return row ? buildSchema.parse(JSON.parse(String(row.data))) : null;
  }

  enqueue(type: string, payload: object, dedupe: string, runAt = Date.now()) {
    this.sql
      .prepare(
        `INSERT OR IGNORE INTO tasks(id,dedupe,type,payload,run_at)
      VALUES(?,?,?,?,?)`,
      )
      .run(opaqueId("task"), dedupe, type, JSON.stringify(payload), runAt);
  }
  claim(now = Date.now()): Task | null {
    return this.transaction(() => {
      const row = this.sql
        .prepare(
          `SELECT id,type,payload,attempts,lease_until FROM tasks
        WHERE done=0 AND run_at<=? AND lease_until<=?
        ORDER BY CASE WHEN type='cleanup' THEN 0 ELSE 1 END,run_at LIMIT 1`,
        )
        .get(now, now);
      if (!row) return null;
      this.sql
        .prepare("UPDATE tasks SET lease_until=?,attempts=attempts+1 WHERE id=?")
        .run(now + 120_000, String(row.id));
      return taskSchema.parse({
        ...row,
        attempts: Number(row.attempts) + 1,
        lease_until: now + 120_000,
      });
    });
  }
  renew(id: string) {
    this.sql
      .prepare("UPDATE tasks SET lease_until=? WHERE id=? AND done=0")
      .run(Date.now() + 120_000, id);
  }
  complete(id: string) {
    this.sql.prepare("UPDATE tasks SET done=1,lease_until=0 WHERE id=?").run(id);
  }
  defer(task: Task) {
    this.sql
      .prepare("UPDATE tasks SET lease_until=0,run_at=?,attempts=attempts-1 WHERE id=?")
      .run(Date.now() + 30_000, task.id);
  }
  retry(task: Task, message: string) {
    const delay = Math.min(300_000, 1_000 * 2 ** Math.min(task.attempts, 8));
    this.sql
      .prepare(`UPDATE tasks SET lease_until=0,run_at=?,error=?,done=? WHERE id=?`)
      .run(
        Date.now() + delay,
        message.slice(0, 200),
        task.attempts >= 8 ? 1 : 0,
        task.id,
      );
  }
}
