import assert from "node:assert/strict";
import test from "node:test";
import { fixture, published } from "./fixtures.js";
import { renderComment } from "../src/builds/comments.js";

const repository = "pyrite-project/pyrite-ide";

test("duplicate PR synchronization dispatches once from the PR base branch", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  await f.service.synchronize(repository, 1);
  assert.equal(f.db.builds().length, 1);
  const b = f.db.builds()[0]!;
  assert.equal(b.baseRef, "develop");
  assert.equal(b.sourceSha, "a".repeat(40));
  assert.notEqual(b.workflowSha, b.sourceSha);
  await f.execution.dispatch(b.id);
  await f.execution.dispatch(b.id);
  assert.equal(f.github.dispatched.length, 1);
});

test("PR author without write access may rebuild but retains the external warning", async (t) => {
  const f = fixture(t);
  const p = await f.service.refresh(repository, 1);
  assert.equal(p.authorTrusted, false);
  const a = await f.service.rebuild(
    p,
    { id: 42, login: "contributor" },
    "latest",
    p.headSha,
    "confirmation-a",
  );
  const b = await f.service.rebuild(
    p,
    { id: 42, login: "contributor" },
    "latest",
    p.headSha,
    "confirmation-a",
  );
  assert.equal(a.id, b.id);
  assert.equal(f.db.builds().length, 1);
  await assert.rejects(
    f.service.rebuild(
      p,
      { id: 17, login: "stranger" },
      "latest",
      p.headSha,
      "confirmation-b",
    ),
    (error: Error) => error.message.includes("权限"),
  );
});

test("simultaneous confirmations are idempotent and preserve one generation", async (t) => {
  const f = fixture(t),
    p = await f.service.refresh(repository, 1);
  const requests = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.service.rebuild(
        p,
        { id: 42, login: "contributor" },
        "latest",
        p.headSha,
        "same-confirmation",
      ),
    ),
  );
  assert.equal(new Set(requests.map((b) => b.id)).size, 1);
  assert.equal(f.db.pull(p.id)!.generation, 1);
});

test("new head cancels the previous generation instead of changing its source", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  const old = f.db.builds()[0]!;
  f.github.snapshot.head.sha = "c".repeat(40);
  await f.service.synchronize(repository, 1);
  assert.equal(f.db.build(old.id)!.status, "cancelled");
  assert.equal(f.db.build(old.id)!.sourceSha, "a".repeat(40));
  const latest = f.db.build(f.db.pull(old.pullId)!.latestBuildId!)!;
  assert.equal(latest.sourceSha, "c".repeat(40));
  assert.equal(latest.generation, 2);
});

test("historical rebuild cannot cancel an active head or replace its check", async (t) => {
  const f = await published(t);
  const historicSha = f.build.sourceSha;
  f.github.snapshot.head.sha = "c".repeat(40);
  await f.service.synchronize(repository, 1);
  const pull = f.db.pull(f.pull.id)!;
  const head = f.db.build(pull.latestBuildId!)!;
  await f.execution.dispatch(head.id);
  await assert.rejects(
    f.service.rebuild(
      pull,
      { id: 42, login: "contributor" },
      historicSha,
      historicSha,
      "historic-confirmation",
    ),
    (error: Error) => error.message.includes("最新提交正在构建"),
  );
  assert.equal(f.db.build(head.id)!.status, "running");
  assert.equal(f.db.pull(pull.id)!.latestBuildId, head.id);
  assert.equal(f.db.builds().length, 2);
  await f.execution.sync(head.id);
  const completed = f.db.pull(pull.id)!;
  const history = await f.service.rebuild(
    completed,
    { id: 42, login: "contributor" },
    historicSha,
    historicSha,
    "historic-confirmation",
  );
  await f.feedback.publish(history, f.db.pull(pull.id)!);
  assert.equal(f.github.checks.at(-1)!.build.sourceSha, historicSha);
  assert.equal(f.db.build(head.id)!.status, "success");
});

test("renamed login cannot borrow a replacement account's repository permission", async (t) => {
  const f = fixture(t),
    pull = await f.service.refresh(repository, 1);
  assert.equal(await f.service.authorize({ id: 17, login: "maintainer" }, pull), true);
  f.github.userIds.set("maintainer", 99);
  assert.equal(await f.service.authorize({ id: 17, login: "maintainer" }, pull), false);
  assert.equal(await f.service.authorize({ id: 99, login: "maintainer" }, pull), true);
  assert.equal(
    await f.service.authorize({ id: 42, login: "renamed-author" }, pull),
    true,
  );
});

test("uncertain dispatch times out, frees capacity, and cancels a late matching run", async (t) => {
  const f = fixture(t);
  f.config.MAX_PARALLEL_BUILDS = 1;
  await f.service.synchronize(repository, 1);
  const uncertain = f.db.builds()[0]!;
  const dispatch = f.github.dispatch.bind(f.github);
  f.github.dispatch = async () => {
    throw new Error("Simulated lost dispatch response");
  };
  await f.execution.dispatch(uncertain.id);
  assert.equal(f.db.build(uncertain.id)!.status, "dispatch_unknown");
  f.github.snapshot.number = 2;
  await f.service.synchronize(repository, 2);
  const second = f.db.builds().find((b) => b.prNumber === 2)!;
  assert.equal(await f.execution.dispatch(second.id), false);
  const saved = f.db.build(uncertain.id)!;
  saved.dispatchedAt =
    Date.now() - (f.config.DISPATCH_RESOLUTION_TIMEOUT_SECONDS + 1) * 1000;
  f.db.saveBuild(saved);
  await f.execution.sync(saved.id);
  assert.equal(f.db.build(saved.id)!.status, "timed_out");
  assert.equal(f.github.checks.at(-1)!.update.conclusion, "timed_out");
  f.github.dispatch = dispatch;
  assert.equal(await f.execution.dispatch(second.id), true);
  assert.equal(f.db.build(second.id)!.status, "running");
  await dispatch(saved); // A delayed provider run appears after the timeout.
  await f.execution.sync(saved.id);
  assert(f.github.cancelled.includes(saved.id));
  assert.equal(f.db.build(saved.id)!.status, "timed_out");
  assert.equal(f.github.dispatched.length, 2);
});

test("five jobs publish seven unique packages, matching checksums, and app checks", async (t) => {
  const f = await published(t);
  assert.equal(f.build.status, "success");
  assert.equal(f.build.platforms.length, 5);
  const files = f.db.files(f.pull.id);
  assert.equal(files.length, 14);
  assert.equal(
    files.filter((file) => file.target === "android" && file.kind === "package").length,
    3,
  );
  for (const file of files.filter((file) => file.kind === "package")) {
    assert.match(file.filename, /-[a-f0-9]{12}-[1-9A-HJ-NP-Za-km-z]{12}\./);
    const checksum = files.find((c) => c.packageId === file.id)!;
    assert.equal(checksum.filename, `${file.filename}.sha256`);
    assert.equal(
      f.objects.data.get(checksum.key)!.body.toString(),
      `${file.sha256}  ${file.filename}\n`,
    );
  }
  assert(f.github.checks.some((c) => c.update.status === "in_progress"));
  assert.equal(f.github.checks.at(-1)!.update.conclusion, "success");
  assert(f.github.checks.every((c) => c.build.sourceSha === "a".repeat(40)));
  assert(f.github.comments.at(-1)!.includes("源来自外部"));
  assert(f.github.comments.at(-1)!.includes("macOS Universal"));
  assert(!f.github.comments.at(-1)!.includes("signature="));
  assert(!f.github.comments.at(-1)!.includes("opuae"));
});

test("B2 outage cannot make the App check succeed; upload retry reuses file names", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  const b = f.db.builds()[0]!;
  await f.execution.dispatch(b.id);
  f.github.complete = true;
  f.objects.failTarget = "windows-x64";
  await assert.rejects(f.execution.sync(b.id));
  assert.equal(f.db.build(b.id)!.status, "publishing");
  assert(!f.github.checks.some((c) => c.update.conclusion === "success"));
  const names = f.db.files(b.pullId).map((file) => file.filename);
  f.objects.failTarget = null;
  await f.execution.sync(b.id);
  assert.equal(f.db.build(b.id)!.status, "success");
  assert(
    names.every((name) => f.db.files(b.pullId).some((file) => file.filename === name)),
  );
});

test("an Actions rerun gives the same commit a fresh tag while keeping old downloads", async (t) => {
  const f = await published(t);
  const oldTag = f.build.tag;
  f.github.attempt = 2;
  await f.execution.sync(f.build.id);
  const b = f.db.build(f.build.id)!;
  assert.notEqual(b.tag, oldTag);
  assert.equal(b.attempt, 2);
  assert.equal(
    f.db.files(f.pull.id).filter((file) => file.kind === "package").length,
    14,
  );
});

test("a failed platform produces partial artifacts and a failing aggregate check", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  const b = f.db.builds()[0]!;
  await f.execution.dispatch(b.id);
  f.github.complete = true;
  f.github.failTarget = "windows-x64";
  await f.execution.sync(b.id);
  const done = f.db.build(b.id)!;
  assert.equal(done.status, "partial");
  assert.equal(f.github.checks.at(-1)!.update.conclusion, "failure");
  const body = renderComment(
    f.db.pull(b.pullId)!,
    done,
    f.db.files(b.pullId),
    f.config.publicUrl,
  );
  assert(body.includes("在 1 个平台构建失败"));
  assert.equal(f.db.files(b.pullId).filter((file) => file.kind === "package").length, 6);
});

test("closed PR is cleaned after 24 hours, without rewriting historic successful checks", async (t) => {
  const f = await published(t);
  const checks = f.github.checks.length;
  const closedAt = Date.now() - 25 * 3_600_000;
  f.github.snapshot.state = "closed";
  f.github.snapshot.closed_at = new Date(closedAt).toISOString();
  await f.service.refresh(repository, 1);
  await f.execution.cleanup(f.pull.id, closedAt);
  const p = f.db.pull(f.pull.id)!;
  assert.equal(p.cleaned, true);
  assert.equal(f.objects.removed.length, 14);
  assert.equal(f.github.checks.length, checks);
  await assert.rejects(
    f.service.rebuild(
      p,
      { id: 42, login: "contributor" },
      "latest",
      p.headSha,
      "after-cleanup",
    ),
  );
});

test("cleanup removes upload retry versions and remains pending after deletion failure", async (t) => {
  const f = await published(t);
  const file = f.db.files(f.pull.id).find((file) => file.kind === "checksum")!;
  f.objects.versions.get(file.key)!.add("accepted-before-lost-response");
  const closedAt = Date.now() - 25 * 3_600_000;
  f.github.snapshot.state = "closed";
  f.github.snapshot.closed_at = new Date(closedAt).toISOString();
  f.objects.failDelete = true;
  await assert.rejects(f.execution.cleanup(f.pull.id, closedAt));
  assert.equal(f.db.pull(f.pull.id)!.cleaned, false);
  f.objects.failDelete = false;
  await f.execution.cleanup(f.pull.id, closedAt);
  assert.equal(f.objects.versions.size, 0);
  assert(f.objects.removed.includes("accepted-before-lost-response"));
  assert.equal(f.db.pull(f.pull.id)!.cleaned, true);
});

test("reopening before cleanup cancels the old close generation", async (t) => {
  const f = await published(t);
  const close = Date.now() - 25 * 3_600_000;
  f.github.snapshot.state = "closed";
  f.github.snapshot.closed_at = new Date(close).toISOString();
  await f.service.refresh(repository, 1);
  f.github.snapshot.state = "open";
  f.github.snapshot.closed_at = null;
  await f.service.synchronize(repository, 1);
  await f.execution.cleanup(f.pull.id, close);
  assert.equal(f.objects.removed.length, 0);
  assert.equal(f.db.pull(f.pull.id)!.cleanupAt, null);
  assert.equal(f.db.builds().length, 2);
});

test("a late dispatch response cannot revive a head replaced during the API call", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  const old = f.db.builds()[0]!;
  const dispatch = f.github.dispatch.bind(f.github);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.github.dispatch = async (build) => {
    started();
    await gate;
    return dispatch(build);
  };
  const pending = f.execution.dispatch(old.id);
  await entered;
  f.github.snapshot.head.sha = "c".repeat(40);
  await f.service.synchronize(repository, 1);
  release();
  await pending;
  assert.equal(f.db.build(old.id)!.status, "cancelled");
  assert(f.db.build(old.id)!.runId);
  assert(f.github.cancelled.includes(old.id));
});

test("dispatch recovery API outage still releases capacity at its final deadline", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  const build = f.db.builds()[0]!;
  build.status = "dispatch_unknown";
  build.dispatchedAt =
    Date.now() - (f.config.DISPATCH_RESOLUTION_TIMEOUT_SECONDS + 1) * 1000;
  f.db.saveBuild(build);
  f.github.findRuns = async () => {
    throw new Error("Provider unavailable");
  };
  await f.execution.sync(build.id);
  assert.equal(f.db.build(build.id)!.status, "timed_out");
  assert.equal(f.db.activeBuilds().length, 0);
});

test("run discovery cannot revive a build cancelled while awaiting GitHub", async (t) => {
  const f = fixture(t);
  await f.service.synchronize(repository, 1);
  const old = f.db.builds()[0]!;
  await f.github.dispatch(old);
  old.status = "dispatch_unknown";
  old.dispatchedAt = Date.now();
  f.db.saveBuild(old);
  const findRuns = f.github.findRuns.bind(f.github);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.github.findRuns = async (build) => {
    started();
    await gate;
    return findRuns(build);
  };
  const pending = f.execution.sync(old.id);
  await entered;
  f.github.snapshot.head.sha = "c".repeat(40);
  await f.service.synchronize(repository, 1);
  release();
  await pending;
  assert.equal(f.db.build(old.id)!.status, "cancelled");
  assert(f.github.cancelled.includes(old.id));
});
