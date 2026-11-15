import assert from "node:assert/strict";
import test from "node:test";
import { Probot } from "probot";
import { GitHubClient } from "../src/github/client.js";

test("permission adapter compares the returned numeric identity before granting write", async (t) => {
  const app = new Probot({ appId: 123, privateKey: "fake-unit-test-key" });
  let id = 17;
  t.mock.method(app, "auth", async () => ({
    request: async () => ({ data: { permission: "write", user: { id } } }),
  }));
  const github = new GitHubClient(app, 123);
  assert.equal(await github.permission(1, "org/repo", "old-login", 17), "write");
  id = 99;
  assert.equal(await github.permission(1, "org/repo", "old-login", 17), "none");
});
