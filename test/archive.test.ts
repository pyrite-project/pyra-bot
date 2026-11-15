import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zip } from "./fixtures.js";
import { extractPackages } from "../src/artifacts/archive.js";

test("artifact reader accepts only the expected regular package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pyra-zip-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, "data.zip"),
    output = join(directory, "out");
  await mkdir(output);
  await writeFile(
    archive,
    await zip([{ name: "linux-x64.tar.gz", data: Buffer.from("native package bytes") }]),
  );
  const files = await extractPackages(archive, output, ["linux-x64.tar.gz"], 1000, 1000);
  assert.equal(
    (await readFile(files.get("linux-x64.tar.gz")!)).toString(),
    "native package bytes",
  );
});

for (const unsafe of ["unexpected", "duplicate", "symlink", "oversized", "traversal"]) {
  test(`artifact reader rejects ${unsafe} entries`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pyra-zip-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const archive = join(directory, "data.zip"),
      output = join(directory, "out");
    await mkdir(output);
    const expected = unsafe === "traversal" ? "1234567" : "package.zip";
    let entries = [{ name: expected, data: Buffer.from("payload"), mode: 0o100600 }];
    if (unsafe === "unexpected") entries[0]!.name = "script.sh";
    if (unsafe === "duplicate") entries.push({ ...entries[0]! });
    if (unsafe === "symlink") entries[0]!.mode = 0o120777;
    if (unsafe === "oversized") entries[0]!.data = Buffer.alloc(100);
    let bytes = await zip(entries);
    if (unsafe === "traversal") {
      // Replace equal-length local/central filenames; CRC covers content, not names.
      bytes = Buffer.from(
        bytes.toString("latin1").replaceAll("1234567", "../evil"),
        "latin1",
      );
    }
    await writeFile(archive, bytes);
    await assert.rejects(extractPackages(archive, output, [expected], 50, 1000));
  });
}
