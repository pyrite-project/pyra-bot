import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { fixture, published } from "./fixtures.js";
import { createHttp } from "../src/web/app.js";
import { Sessions } from "../src/web/sessions.js";
import { OAuthFlows } from "../src/web/oauth.js";
import { renderPage } from "../src/web/pages.js";

function token(html: string, name = "csrf") {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert(match, `Missing ${name}`);
  return match[1]!;
}

test("checksum bypasses the intermediate pages and creates no browser session", async (t) => {
  const f = await published(t);
  const sessions = new Sessions(f.db, false);
  const oauth = new OAuthFlows(f.db, f.config, {
    exchange: async () => ({ id: 42, login: "contributor" }),
  });
  const app = createHttp(f.config, f.service, f.objects, sessions, oauth);
  const checksum = f.db.files(f.pull.id).find((file) => file.kind === "checksum")!;
  const result = await request(app).get(`/builder/download/${checksum.id}`).expect(302);
  assert(result.headers.location);
  assert(result.headers.location.includes(checksum.id));
  assert(!result.headers["set-cookie"]);
  assert(!result.text.includes("data-confirm"));
  assert.equal(f.objects.signed.length, 1);
});

test("package confirmation has a real POST and a forged started hash cannot authorize download", async (t) => {
  const f = await published(t);
  const sessions = new Sessions(f.db, false);
  const oauth = new OAuthFlows(f.db, f.config, {
    exchange: async () => ({ id: 42, login: "contributor" }),
  });
  const app = createHttp(f.config, f.service, f.objects, sessions, oauth);
  const agent = request.agent(app);
  const file = f.db.files(f.pull.id).find((file) => file.kind === "package")!;
  const path = `/builder/download/${file.id}`;
  const page = await agent.get(path).expect(200);
  assert(page.text.includes('data-receipt="false"'));
  assert(page.text.includes("此文件的安全性未经验证"));
  assert.equal(f.objects.signed.length, 0);
  await agent.post(path).type("form").send({ csrf: "forged" }).expect(403);
  assert.equal(f.objects.signed.length, 0);
  await agent
    .post(path)
    .set("Accept", "application/json")
    .type("form")
    .send({ csrf: token(page.text) })
    .expect(200);
  assert.equal(f.objects.signed.length, 1);
  const started = await agent.get(path).expect(200);
  assert(started.text.includes('data-receipt="true"'));
});

test("source warning depends on the PR author permission, not the downloader", async (t) => {
  const f = await published(t);
  f.github.permissions.set("contributor", "write");
  const app = createHttp(
    f.config,
    f.service,
    f.objects,
    new Sessions(f.db, false),
    new OAuthFlows(f.db, f.config, {
      exchange: async () => ({ id: 42, login: "contributor" }),
    }),
  );
  const file = f.db.files(f.pull.id).find((file) => file.kind === "package")!;
  const page = await request(app).get(`/builder/download/${file.id}`).expect(200);
  assert(!page.text.includes("此文件的安全性未经验证"));
});

test("anonymous GET never rebuilds; author OAuth login and repeated confirmation create one build", async (t) => {
  const f = fixture(t);
  const sessions = new Sessions(f.db, false);
  let exchanges = 0;
  const oauth = new OAuthFlows(f.db, f.config, {
    exchange: async (_code, verifier) => {
      assert(verifier.length >= 43);
      exchanges++;
      return { id: 42, login: "contributor" };
    },
  });
  const app = createHttp(f.config, f.service, f.objects, sessions, oauth),
    agent = request.agent(app);
  const path = "/builder/rebuild/pyrite-project/pyrite-ide/1/latest";
  const login = await agent.get(path).expect(200);
  assert(login.text.includes("登陆以重新构建 #1"));
  assert.equal(f.db.builds().length, 0);
  const start = await agent
    .post("/builder/oauth/start")
    .type("form")
    .send({
      csrf: token(login.text),
      returnPath: path,
      switchAccount: "0",
    })
    .expect(303);
  assert(start.headers.location);
  const url = new URL(start.headers.location);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert(url.searchParams.get("code_challenge")?.length === 43);
  const state = url.searchParams.get("state")!;
  await request(app)
    .get("/builder/oauth/callback")
    .query({ code: "example", state })
    .expect(503);
  assert.equal(exchanges, 0);
  await agent
    .get("/builder/oauth/callback")
    .query({ code: "example", state })
    .expect(303);
  assert.equal(exchanges, 1);
  const confirmation = await agent.get(path).expect(200);
  assert(confirmation.text.includes("重新构建这个提交？"));
  const body = {
    csrf: token(confirmation.text),
    sha: f.github.snapshot.head.sha,
    confirmation: token(confirmation.text, "confirmation"),
  };
  await agent
    .post(path)
    .type("form")
    .send({ ...body, csrf: "bad" })
    .expect(403);
  await agent
    .post(path)
    .set("Accept", "application/json")
    .type("form")
    .send(body)
    .expect(200);
  await agent
    .post(path)
    .set("Accept", "application/json")
    .type("form")
    .send(body)
    .expect(200);
  assert.equal(f.db.builds().length, 1);
  assert.equal(f.db.builds()[0]!.actor, "contributor");
  await agent
    .get("/builder/oauth/callback")
    .query({ code: "example", state })
    .expect(503);
  assert.equal(exchanges, 1);
});

test("download signature does not outlive the close cleanup deadline", async (t) => {
  const f = await published(t);
  f.github.snapshot.state = "closed";
  f.github.snapshot.closed_at = new Date(Date.now() - 86_400_000 + 60_000).toISOString();
  const app = createHttp(
    f.config,
    f.service,
    f.objects,
    new Sessions(f.db, false),
    new OAuthFlows(f.db, f.config, {
      exchange: async () => ({ id: 42, login: "contributor" }),
    }),
  );
  const checksum = f.db.files(f.pull.id).find((file) => file.kind === "checksum")!;
  await request(app).get(`/builder/download/${checksum.id}`).expect(302);
  assert(f.objects.signed.at(-1)!.seconds <= 60);
  f.github.snapshot.closed_at = new Date(Date.now() - 86_400_001).toISOString();
  const expired = await request(app).get(`/builder/download/${checksum.id}`).expect(410);
  assert(expired.text.includes("由于过期，此文件已被清理。"));
});

test("HTML output escapes filenames and account names without changing Paper copy", () => {
  const denied = renderPage(
    {
      kind: "denied",
      login: 'x<"script',
      returnPath: "/builder/rebuild/org/repo/1/latest",
    },
    "csrf",
  );
  assert(!denied.includes('x<"script'));
  assert(denied.includes("你没有重新构建此 PR 的权限"));
  const html = renderPage(
    {
      kind: "download",
      filename: "<img src=x onerror=alert(1)>.zip",
      sha: "a".repeat(40),
      platform: "macOS Universal",
      warning: false,
      path: "/builder/download/file_example",
      started: false,
    },
    "csrf",
  );
  assert(!html.includes("<img src=x"));
  assert(html.includes("&lt;img"));
  assert(!html.includes("Dashboard"));
});
