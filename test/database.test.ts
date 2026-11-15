import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../src/storage/database.js";

test("task dedupe and an expired lease survive database reopening", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pyra-db-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite"),
    first = new Database(path);
  first.enqueue("pull", { number: 1 }, "delivery-1", 0);
  first.enqueue("pull", { number: 1 }, "delivery-1", 0);
  const task = first.claim(1)!;
  assert(task);
  assert.equal(first.claim(2), null);
  first.close();
  const next = new Database(path);
  const recovered = next.claim(120_002)!;
  assert.equal(recovered.id, task.id);
  assert.equal(recovered.attempts, 2);
  next.complete(task.id);
  assert.equal(next.claim(240_003), null);
  next.close();
});
