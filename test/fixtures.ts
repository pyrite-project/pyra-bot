import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { ZipFile } from "yazl";
import type { Config } from "../src/config.js";
import { readConfig } from "../src/config.js";
import { Database } from "../src/storage/database.js";
import { targets, type ArtifactFile, type Build } from "../src/builds/model.js";
import type {
  GitHub,
  PullSnapshot,
  Run,
  Job,
  GitHubArtifact,
  CheckUpdate,
} from "../src/github/client.js";
import type { Objects } from "../src/artifacts/objects.js";
import { Publisher } from "../src/artifacts/publisher.js";
import { BuildService } from "../src/builds/service.js";
import { Feedback } from "../src/builds/feedback.js";
import { Execution } from "../src/builds/execution.js";

export function zip(
  entries: { name: string; data: Buffer; mode?: number }[],
): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (c: Buffer) => chunks.push(c));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  for (const entry of entries)
    archive.addBuffer(entry.data, entry.name, { mode: entry.mode });
  archive.end();
  return done;
}

export class FakeGitHub implements GitHub {
  snapshot: PullSnapshot = {
    number: 1,
    state: "open",
    merged: false,
    user: { id: 42, login: "contributor" },
    closed_at: null,
    head: {
      sha: "a".repeat(40),
      repo: { id: 2, full_name: "contributor/ide", private: false },
    },
    base: {
      ref: "develop",
      sha: "b".repeat(40),
      repo: { id: 1, full_name: "pyrite-project/pyrite-ide", private: false },
    },
    installationId: 100,
  };
  permissions = new Map<string, string>([["maintainer", "write"]]);
  userIds = new Map<string, number>([
    ["maintainer", 17],
    ["contributor", 42],
  ]);
  runs = new Map<number, Run>();
  dispatched: Build[] = [];
  checks: { build: Build; update: CheckUpdate }[] = [];
  comments: string[] = [];
  cancelled: string[] = [];
  archives = new Map<number, Buffer>();
  complete = false;
  attempt = 1;
  failTarget: string | null = null;
  async pull() {
    return structuredClone(this.snapshot);
  }
  async permission(
    _installationId: number,
    _repo: string,
    login: string,
    expectedUserId: number,
  ) {
    return this.userIds.get(login) === expectedUserId
      ? (this.permissions.get(login) ?? "none")
      : "none";
  }
  async workflow(_installationId: number, _repo: string, ref: string) {
    if (ref !== this.snapshot.base.ref) throw new Error("Unexpected workflow ref");
    return this.snapshot.base.sha;
  }
  async dispatch(build: Build) {
    this.dispatched.push(structuredClone(build));
    const id = 1000 + this.dispatched.length;
    this.runs.set(id, {
      id,
      run_attempt: 1,
      head_sha: build.workflowSha,
      event: "workflow_dispatch",
      path: ".github/workflows/pr-build.yml",
      display_title: `pyra:${build.id}`,
      status: "queued",
      conclusion: null,
      html_url: `https://github.com/${build.fullName}/actions/runs/${id}`,
      run_started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      actor: { login: "pyra[bot]", type: "Bot" },
    });
    return id;
  }
  async run(_installationId: number, _repo: string, id: number) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Unknown run");
    return {
      ...run,
      run_attempt: this.attempt,
      status: this.complete ? "completed" : "in_progress",
      conclusion: this.complete ? (this.failTarget ? "failure" : "success") : null,
    };
  }
  async findRuns(build: Build) {
    return [...this.runs.values()].filter((r) => r.display_title === `pyra:${build.id}`);
  }
  async jobs(): Promise<Job[]> {
    return targets.map((t, i) => ({
      id: 100 + i,
      name: `pyra-${t.id}`,
      status: this.complete ? "completed" : "in_progress",
      conclusion: this.complete
        ? t.id === this.failTarget
          ? "failure"
          : "success"
        : null,
      html_url: `https://github.com/test/jobs/${100 + i}`,
    }));
  }
  async artifacts(): Promise<GitHubArtifact[]> {
    const artifacts: GitHubArtifact[] = [];
    for (const [i, target] of targets.entries()) {
      const data = await zip(
        target.files.map((name) => ({ name, data: Buffer.from(`test package ${name}`) })),
      );
      this.archives.set(i + 1, data);
      artifacts.push({
        id: i + 1,
        name: `pyra-${target.id}-${this.attempt}`,
        expired: false,
        size_in_bytes: data.length,
        digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      });
    }
    return artifacts;
  }
  async archive(_build: Build, id: number) {
    const data = this.archives.get(id);
    if (!data) throw new Error("Unknown artifact");
    return new Response(new Uint8Array(data));
  }
  async cancel(build: Build) {
    this.cancelled.push(build.id);
  }
  async check(build: Build, update: CheckUpdate) {
    this.checks.push({ build: structuredClone(build), update: structuredClone(update) });
    return build.checkId ?? 7000 + this.checks.length;
  }
  async comment(
    _installationId: number,
    _repo: string,
    _pr: number,
    _comment: number | null,
    _marker: string,
    body: string,
  ) {
    this.comments.push(body);
    return 9001;
  }
  async openPulls() {
    return [1];
  }
}

export class FakeObjects implements Objects {
  data = new Map<
    string,
    { version: string; size: number; sha256: string; body: Buffer }
  >();
  versions = new Map<string, Set<string>>();
  puts: ArtifactFile[] = [];
  removed: string[] = [];
  signed: { file: ArtifactFile; seconds: number }[] = [];
  failTarget: string | null = null;
  failDelete = false;
  async head(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(file: ArtifactFile, source: string | Buffer) {
    if (file.target === this.failTarget) throw new Error("Simulated upload outage");
    const body = typeof source === "string" ? await readFile(source) : source;
    const version = `version-${this.puts.length + 1}`;
    this.data.set(file.key, {
      version,
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      body,
    });
    const versions = this.versions.get(file.key) ?? new Set<string>();
    versions.add(version);
    this.versions.set(file.key, versions);
    this.puts.push(structuredClone(file));
    return version;
  }
  async sign(file: ArtifactFile, seconds: number) {
    this.signed.push({ file, seconds });
    return `https://s3.test.invalid/bucket/${file.id}?signature=example`;
  }
  async remove(file: ArtifactFile) {
    if (this.failDelete) throw new Error("Simulated deletion outage");
    this.removed.push(...(this.versions.get(file.key) ?? []));
    this.versions.delete(file.key);
    this.data.delete(file.key);
  }
}

export function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pyra-test-"));
  const key = join(directory, "fake.pem");
  writeFileSync(key, "not-a-real-private-key");
  const config: Config = readConfig({
    APP_ID: "123",
    PRIVATE_KEY_PATH: key,
    WEBHOOK_SECRET: "fake-webhook-secret-for-unit-tests",
    GITHUB_CLIENT_ID: "fake-client",
    GITHUB_CLIENT_SECRET: "fake-secret",
    PUBLIC_URL: "http://localhost:3000",
    GITHUB_REPOSITORIES: "pyrite-project/pyrite-ide",
    BUILD_BASE_BRANCHES: "main,develop",
    DATABASE_PATH: join(directory, "db.sqlite"),
    TEMP_DIRECTORY: join(directory, "tmp"),
    B2_ENDPOINT: "https://s3.test.invalid",
    B2_REGION: "test",
    B2_BUCKET: "test",
    B2_UPLOAD_KEY_ID: "fake-upload-id",
    B2_UPLOAD_KEY: "fake-upload-key",
    B2_READ_KEY_ID: "fake-read-id",
    B2_READ_KEY: "fake-read-key",
    B2_DELETE_KEY_ID: "fake-delete-id",
    B2_DELETE_KEY: "fake-delete-key",
  });
  const db = new Database(":memory:");
  const github = new FakeGitHub(),
    objects = new FakeObjects();
  const service = new BuildService(db, github, config);
  const feedback = new Feedback(db, github, config.publicUrl);
  const publisher = new Publisher(db, github, objects, config);
  const execution = new Execution(service, feedback, publisher, objects);
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    config,
    db,
    github,
    objects,
    service,
    feedback,
    publisher,
    execution,
  };
}

export async function published(t: TestContext) {
  const f = fixture(t);
  await f.service.synchronize("pyrite-project/pyrite-ide", 1);
  const build = f.db.builds()[0]!;
  await f.execution.dispatch(build.id);
  f.github.complete = true;
  await f.execution.sync(build.id);
  return { ...f, build: f.db.build(build.id)!, pull: f.db.pull(build.pullId)! };
}
