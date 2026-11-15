import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { targets } from "../src/builds/model.js";

test("IDE workflow and App agree on jobs and keep untrusted builds unprivileged", async () => {
  const source = await readFile(
    new URL("../../pyrite-ide/.github/workflows/pr-build.yml", import.meta.url),
    "utf8",
  );
  const workflow = z
    .object({
      on: z.object({
        workflow_dispatch: z.object({ inputs: z.record(z.string(), z.unknown()) }),
      }),
      permissions: z.object({ contents: z.literal("read") }).strict(),
      "cache-mode": z.literal("none"),
      jobs: z.object({
        analyze: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }),
        build: z.object({
          name: z.string(),
          strategy: z.object({
            "fail-fast": z.literal(false),
            matrix: z.object({
              include: z.array(z.object({ target: z.string(), runner: z.string() })),
            }),
          }),
          steps: z.array(z.record(z.string(), z.unknown())),
        }),
      }),
    })
    .parse(parse(source));
  assert.deepEqual(
    workflow.jobs.build.strategy.matrix.include.map((row) => row.target),
    targets.map((t) => t.id),
  );
  assert(!source.includes("secrets."));
  assert(!source.includes("pull_request_target"));
  assert(source.includes("persist-credentials: false"));
  assert(source.includes("lipo -verify_arch arm64 x86_64"));
  assert(!source.includes("macos-x64"));
  const steps = [...workflow.jobs.analyze.steps, ...workflow.jobs.build.steps];
  for (const step of steps)
    if (typeof step.uses === "string") assert.match(step.uses, /@[a-f0-9]{40}$/);
  assert(workflow.on.workflow_dispatch.inputs.source_repository);
});
