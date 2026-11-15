import { createReadStream } from "node:fs";
import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactFile } from "../builds/model.js";
import type { Config } from "../config.js";

export interface Objects {
  head(
    key: string,
    version?: string | null,
  ): Promise<{ version: string; size: number; sha256: string } | null>;
  put(file: ArtifactFile, source: string | Buffer): Promise<string>;
  sign(file: ArtifactFile, seconds: number): Promise<string>;
  /** Permanently remove every version and delete marker of this exact key. */
  remove(file: ArtifactFile): Promise<void>;
}

/** Separate B2 credentials for uploading, signing reads, and permanent version deletion. */
export class B2Objects implements Objects {
  private readonly upload: S3Client;
  private readonly read: S3Client;
  private readonly deletion: S3Client;
  constructor(private readonly config: Config) {
    const client = (accessKeyId: string, secretAccessKey: string) =>
      new S3Client({
        endpoint: config.B2_ENDPOINT,
        region: config.B2_REGION,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
        maxAttempts: 3,
      });
    this.upload = client(config.B2_UPLOAD_KEY_ID, config.B2_UPLOAD_KEY);
    this.read = client(config.B2_READ_KEY_ID, config.B2_READ_KEY);
    this.deletion = client(config.B2_DELETE_KEY_ID, config.B2_DELETE_KEY);
  }
  async head(key: string, version?: string | null) {
    try {
      const r = await this.read.send(
        new HeadObjectCommand({
          Bucket: this.config.B2_BUCKET,
          Key: key,
          ...(version ? { VersionId: version } : {}),
        }),
      );
      if (!r.VersionId) throw new Error("B2 did not return a version ID");
      return {
        version: r.VersionId,
        size: r.ContentLength ?? -1,
        sha256: r.Metadata?.sha256 ?? "",
      };
    } catch (error) {
      if (
        error instanceof Error &&
        ["NotFound", "NoSuchKey", "NoSuchVersion"].includes(error.name)
      )
        return null;
      throw error;
    }
  }
  async put(file: ArtifactFile, source: string | Buffer) {
    const result = await new Upload({
      client: this.upload,
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
      params: {
        Bucket: this.config.B2_BUCKET,
        Key: file.key,
        Body: typeof source === "string" ? createReadStream(source) : source,
        ContentLength: file.size,
        Metadata: { sha256: file.sha256 },
        ContentType:
          file.kind === "checksum"
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
        ContentDisposition: `attachment; filename="${file.filename}"`,
      },
    }).done();
    if (!result.VersionId) throw new Error("B2 upload returned no version ID");
    return result.VersionId;
  }
  async sign(file: ArtifactFile, seconds: number) {
    if (!file.version || seconds < 1)
      throw new Error("File is not available for signing");
    return getSignedUrl(
      this.read,
      new GetObjectCommand({
        Bucket: this.config.B2_BUCKET,
        Key: file.key,
        VersionId: file.version,
      }),
      { expiresIn: seconds },
    );
  }
  async remove(file: ArtifactFile) {
    // A successful upload followed by a lost response can create retry versions.
    // B2 version listing: https://www.backblaze.com/apidocs/s3-list-object-versions
    const versions = new Set<string>();
    if (file.version) versions.add(file.version);
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await this.deletion.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.B2_BUCKET,
          Prefix: file.key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      for (const entry of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        // A package prefix also matches its .sha256 sibling: never delete that here.
        if (entry.Key === file.key) {
          if (!entry.VersionId)
            throw new Error("B2 version listing omitted a version ID");
          versions.add(entry.VersionId);
        }
      }
      if (!page.IsTruncated) break;
      if (
        !page.NextKeyMarker ||
        (page.NextKeyMarker === keyMarker && page.NextVersionIdMarker === versionMarker)
      )
        throw new Error("B2 version pagination did not advance");
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
    for (const version of versions) {
      await this.deletion.send(
        new DeleteObjectCommand({
          Bucket: this.config.B2_BUCKET,
          Key: file.key,
          VersionId: version,
        }),
      );
    }
  }
}
