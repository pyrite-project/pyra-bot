import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { type TestContext } from "node:test";
import { Probot } from "probot";
import { registerWebhooks } from "../src/github/webhooks.js";
import { Sessions } from "../src/web/sessions.js";
import { Worker } from "../src/storage/worker.js";
import { fixture } from "./fixtures.js";

const repository = "pyrite-project/pyrite-ide";

function commentPayload() {
  const user = { id: 42, login: "contributor", type: "User" };
  return {
    action: "created",
    repository: { id: 1, full_name: repository },
    installation: { id: 100 },
    issue: { number: 1, pull_request: {} },
    comment: { id: 500, body: "/rebuild", user },
    sender: { ...user },
  };
}

async function harness(t: TestContext) {
  const f = fixture(t);
  const app = new Probot({
    appId: 123,
    privateKey: "fake-unit-test-key",
    secret: f.config.WEBHOOK_SECRET,
    logLevel: "fatal",
  });
  await app.load(registerWebhooks(f.service, new Sessions(f.db, false)));
  const worker = new Worker(f.service, f.execution, f.feedback);
  let delivery = 0;
  return {
    ...f,
    worker,
    async receive(payload: unknown, name = "issue_comment", signature?: string) {
      const body = JSON.stringify(payload);
      await app.webhooks.verifyAndReceive({
        id: `delivery-${++delivery}`,
        name,
        payload: body,
        signature:
          signature ??
          `sha256=${createHmac("sha256", f.config.WEBHOOK_SECRET)
            .update(body)
            .digest("hex")}`,
      });
    },
    async drain() {
      for (let n = 0; n < 30; n++) if (!(await worker.runOne())) return;
      assert.fail("Command tasks did not settle");
    },
  };
}

test("signed PR command bootstraps an untracked fork PR and survives automatic scanning", async (t) => {
  const f = await harness(t);
  assert.equal(f.db.pulls().length, 0);
  const payload = commentPayload();
  payload.comment.body = " \n/rebuild\r\n";
  await f.receive(payload);
  await f.receive(payload); // GitHub redelivery has a different delivery ID.
  assert.equal(f.db.builds().length, 0); // Webhook only persists the command.
  assert.equal(await f.worker.runOne(), true);
  const build = f.db.builds()[0]!;
  assert.equal(build.actor, "contributor");
  assert.equal(build.sourceSha, f.github.snapshot.head.sha);
  assert.equal(build.sourceRepo, "contributor/ide");
  assert.equal(build.baseRef, "develop");
  await f.service.synchronize(repository, 1);
  assert.equal(f.db.builds().length, 1);
  assert.equal(f.db.build(build.id)!.status, "queued");
  await f.drain();
  assert.equal(f.github.dispatched.length, 1);
  assert(f.github.comments.some((body) => body.includes("来自 @contributor 的请求")));
  assert(f.github.checks.every((check) => check.build.sourceSha === build.sourceSha));
  const repeated = await f.service.rebuildFromComment(
    repository,
    1,
    { id: 42, login: "contributor" },
    payload.comment.id,
  );
  assert.equal(repeated.id, build.id);
});

test("repository writer can start an untracked PR; strangers cannot", async (t) => {
  const f = await harness(t),
    payload = commentPayload();
  payload.comment.user = { id: 17, login: "maintainer", type: "User" };
  payload.sender = { ...payload.comment.user };
  await f.receive(payload);
  await f.worker.runOne();
  assert.equal(f.db.builds()[0]!.actor, "maintainer");
  await f.drain();
  payload.comment.id++;
  payload.comment.user = { id: 99, login: "stranger", type: "User" };
  payload.sender = { ...payload.comment.user };
  await f.receive(payload);
  await f.drain();
  assert.equal(f.db.builds().length, 1);
  const rejected = f.db.sql
    .prepare(
      "SELECT done,attempts FROM tasks WHERE type='comment-rebuild' AND json_extract(payload,'$.commentId')=?",
    )
    .get(payload.comment.id)!;
  assert.equal(Number(rejected.done), 1);
  assert.equal(Number(rejected.attempts), 1);
});

test("non-command comments, edits, issues, bots, and review comments are ignored", async (t) => {
  const f = await harness(t);
  for (const body of [
    "please /rebuild",
    "> /rebuild",
    "```\n/rebuild\n```",
    "/rebuild now",
  ]) {
    const payload = commentPayload();
    payload.comment.body = body;
    await f.receive(payload);
  }
  await f.receive({ ...commentPayload(), action: "edited" });
  await f.receive({ ...commentPayload(), action: "deleted" });
  await f.receive({ ...commentPayload(), issue: { number: 1 } });
  const bot = commentPayload();
  bot.comment.user.type = "Bot";
  await f.receive(bot);
  const mismatch = commentPayload();
  mismatch.sender.id = 17;
  await f.receive(mismatch);
  await f.receive(commentPayload(), "pull_request_review_comment");
  const otherRepository = commentPayload();
  otherRepository.repository.full_name = "other/repo";
  await f.receive(otherRepository);
  assert.equal(await f.worker.runOne(), false);
  assert.equal(f.db.builds().length, 0);
  assert.equal(f.db.pulls().length, 0);
});

test("invalid webhook signatures cannot enqueue a rebuild", async (t) => {
  const f = await harness(t);
  await assert.rejects(
    f.receive(commentPayload(), "issue_comment", `sha256=${"0".repeat(64)}`),
  );
  assert.equal(await f.worker.runOne(), false);
  assert.equal(f.db.builds().length, 0);
});

test("expired PR command and cooldown rejections do not become delayed rebuilds", async (t) => {
  const f = await harness(t),
    payload = commentPayload();
  f.github.snapshot.state = "closed";
  f.github.snapshot.closed_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
  await f.receive(payload);
  await f.worker.runOne();
  assert.equal(f.db.builds().length, 0);
  f.github.snapshot.state = "open";
  f.github.snapshot.closed_at = null;
  payload.comment.id++;
  await f.receive(payload);
  await f.drain();
  assert.equal(f.db.builds().length, 1);
  payload.comment.id++;
  await f.receive(payload);
  await f.drain();
  assert.equal(f.db.builds().length, 1);
  assert.equal(f.github.dispatched.length, 1);
});
