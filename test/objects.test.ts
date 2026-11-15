import assert from "node:assert/strict";
import test from "node:test";
import {
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { B2Objects } from "../src/artifacts/objects.js";
import { published } from "./fixtures.js";

test("B2 deletion paginates exact-key versions and markers without deleting siblings", async (t) => {
  const f = await published(t);
  const file = f.db.files(f.pull.id).find((file) => file.kind === "package")!;
  const deleted: string[] = [];
  let pages = 0;
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof ListObjectVersionsCommand) {
      assert.equal(command.input.Prefix, file.key);
      pages++;
      if (pages === 1) {
        assert.equal(command.input.KeyMarker, undefined);
        return {
          Versions: [{ Key: file.key, VersionId: file.version }],
          DeleteMarkers: [{ Key: file.key, VersionId: "hidden-version" }],
          IsTruncated: true,
          NextKeyMarker: file.key,
          NextVersionIdMarker: "hidden-version",
        };
      }
      assert.equal(command.input.KeyMarker, file.key);
      assert.equal(command.input.VersionIdMarker, "hidden-version");
      return {
        Versions: [
          { Key: file.key, VersionId: "retry-version" },
          { Key: `${file.key}.sha256`, VersionId: "sibling-version" },
        ],
        IsTruncated: false,
      };
    }
    assert(command instanceof DeleteObjectCommand);
    assert.equal(command.input.Key, file.key);
    assert(command.input.VersionId);
    deleted.push(command.input.VersionId);
    return {};
  });
  await new B2Objects(f.config).remove(file);
  assert.equal(pages, 2);
  assert.deepEqual(
    new Set(deleted),
    new Set([file.version, "hidden-version", "retry-version"]),
  );
});

test("B2 cleanup discovers a version even when upload response was never persisted", async (t) => {
  const f = await published(t);
  const file = { ...f.db.files(f.pull.id)[0]!, version: null };
  const deleted: string[] = [];
  t.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    if (command instanceof ListObjectVersionsCommand) {
      return { Versions: [{ Key: file.key, VersionId: "unknown-version" }] };
    }
    assert(command instanceof DeleteObjectCommand);
    deleted.push(command.input.VersionId!);
    return {};
  });
  await new B2Objects(f.config).remove(file);
  assert.deepEqual(deleted, ["unknown-version"]);
});
