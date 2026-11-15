import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";

export function byteLimit(max: number, onData?: (chunk: Buffer) => void): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > max) {
        done(new Error("Archive or file exceeds the configured size limit"));
        return;
      }
      try {
        onData?.(chunk);
        done(null, chunk);
      } catch (error) {
        done(error instanceof Error ? error : new Error("Invalid stream"));
      }
    },
  });
}

/** Save only expected regular root files; never recursively unpack the native package. */
export async function extractPackages(
  archive: string,
  directory: string,
  expected: readonly string[],
  maxFile: number,
  maxTotal: number,
): Promise<Map<string, string>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, result) => {
        if (error || !result) reject(error ?? new Error("Invalid archive"));
        else resolve(result);
      },
    );
  });
  const files = new Map<string, string>();
  let entries = 0,
    total = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        entries++;
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (
          entries > 16 ||
          !expected.includes(entry.fileName) ||
          files.has(entry.fileName) ||
          !/^[a-z0-9_.-]+$/.test(entry.fileName) ||
          (mode !== 0 && mode !== 0o100000) ||
          entry.uncompressedSize > maxFile ||
          entry.generalPurposeBitFlag & 1
        ) {
          throw new Error(
            "Artifact contains an unexpected, duplicate, unsafe, or oversized entry",
          );
        }
        const stream = await new Promise<Readable>((yes, no) =>
          zip.openReadStream(entry, (error, result) => {
            if (error || !result) no(error ?? new Error("Cannot read artifact"));
            else yes(result);
          }),
        );
        const output = join(directory, entry.fileName);
        await pipeline(
          stream,
          byteLimit(maxFile, (chunk) => {
            total += chunk.length;
            if (total > maxTotal)
              throw new Error("Expanded archive exceeds the configured limit");
          }),
          createWriteStream(output, { flags: "wx", mode: 0o600 }),
        );
        if ((await stat(output)).size !== entry.uncompressedSize)
          throw new Error("Artifact length mismatch");
        files.set(entry.fileName, output);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  if (files.size !== expected.length)
    throw new Error("Artifact is missing an expected package");
  return files;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
