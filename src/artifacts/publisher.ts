import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  filename,
  opaqueId,
  targets,
  type ArtifactFile,
  type Build,
  type TargetId,
} from "../builds/model.js";
import type { Config } from "../config.js";
import type { GitHub, GitHubArtifact } from "../github/client.js";
import type { Database } from "../storage/database.js";
import type { Objects } from "./objects.js";
import { byteLimit, extractPackages, sha256File } from "./archive.js";

export class Publisher {
  constructor(
    private readonly db: Database,
    private readonly github: GitHub,
    private readonly objects: Objects,
    private readonly config: Config,
  ) {}

  /** Retry with the same file IDs, object keys, tag, and checksum content. */
  async publish(
    build: Build,
    target: TargetId,
    artifact: GitHubArtifact,
    ensureActive: () => Promise<void>,
  ): Promise<void> {
    const definition = targets.find((t) => t.id === target)!;
    const previous = this.db
      .files(build.pullId, build.id, build.attempt)
      .filter(
        (f) =>
          f.buildId === build.id && f.attempt === build.attempt && f.target === target,
      );
    if (
      previous.filter((f) => f.state === "ready").length ===
      definition.files.length * 2
    )
      return;
    if (artifact.expired || artifact.size_in_bytes > this.config.MAX_ARCHIVE_BYTES) {
      throw new Error("GitHub artifact expired or exceeds the archive size limit");
    }
    await mkdir(this.config.tempDirectory, { recursive: true });
    const directory = await mkdtemp(join(this.config.tempDirectory, "pyra-"));
    try {
      await ensureActive();
      const response = await this.github.archive(build, artifact.id);
      if (!response.body) throw new Error("Artifact has no response body");
      const archive = join(directory, "artifact.zip");
      const hash = createHash("sha256");
      await pipeline(
        Readable.fromWeb(response.body),
        byteLimit(this.config.MAX_ARCHIVE_BYTES, (chunk) => hash.update(chunk)),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      );
      const digest = hash.digest("hex");
      if (artifact.digest && artifact.digest !== `sha256:${digest}`) {
        throw new Error("GitHub artifact digest mismatch");
      }
      const packages = await extractPackages(
        archive,
        directory,
        definition.files,
        this.config.MAX_FILE_BYTES,
        this.config.MAX_ARCHIVE_BYTES,
      );
      for (const source of definition.files) {
        await ensureActive();
        const path = packages.get(source)!;
        const sha256 = await sha256File(path);
        const size = (await stat(path)).size;
        const name = filename(source, build.sourceSha, build.tag);
        const file: ArtifactFile = previous.find(
          (f) => f.kind === "package" && f.filename === name,
        ) ?? {
          id: opaqueId("file"),
          buildId: build.id,
          pullId: build.pullId,
          target,
          attempt: build.attempt,
          kind: "package",
          filename: name,
          key: [
            this.config.B2_PREFIX.replace(/\/$/, ""),
            build.repositoryId,
            build.prNumber,
            build.sourceSha,
            build.id,
            build.runId,
            build.attempt,
            target,
            name,
          ].join("/"),
          version: null,
          size,
          sha256,
          packageId: null,
          state: "staged",
        };
        if (file.sha256 !== sha256 || file.size !== size)
          throw new Error("Immutable artifact changed during retry");
        const checksumBody = Buffer.from(`${sha256}  ${name}\n`, "utf8");
        const checksum: ArtifactFile = previous.find((f) => f.packageId === file.id) ?? {
          ...file,
          id: opaqueId("file"),
          kind: "checksum",
          filename: `${name}.sha256`,
          key: `${file.key}.sha256`,
          packageId: file.id,
          size: checksumBody.length,
          sha256: createHash("sha256").update(checksumBody).digest("hex"),
          version: null,
          state: "staged",
        };
        this.db.transaction(() => {
          this.db.saveFile(file);
          this.db.saveFile(checksum);
        });
        await this.upload(file, path);
        await ensureActive();
        await this.upload(checksum, checksumBody);
        await ensureActive();
        this.db.transaction(() => {
          file.state = "ready";
          checksum.state = "ready";
          this.db.saveFile(file);
          this.db.saveFile(checksum);
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async upload(file: ArtifactFile, source: string | Buffer) {
    let remote = await this.objects.head(file.key, file.version);
    if (remote && (remote.size !== file.size || remote.sha256 !== file.sha256)) {
      throw new Error("Existing B2 object does not match the staged file");
    }
    if (!remote) {
      file.version = await this.objects.put(file, source);
      this.db.saveFile(file);
      remote = await this.objects.head(file.key, file.version);
    }
    if (!remote || remote.size !== file.size || remote.sha256 !== file.sha256) {
      throw new Error("B2 object verification failed");
    }
    file.version = remote.version;
    this.db.saveFile(file);
  }
}
