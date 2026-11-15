import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";

export const targets = [
  { id: "linux-x64", label: "Linux x64", files: ["linux-x64.tar.gz"] },
  { id: "linux-arm64", label: "Linux arm64", files: ["linux-arm64.tar.gz"] },
  { id: "macos-universal", label: "macOS Universal", files: ["macos-universal.zip"] },
  { id: "windows-x64", label: "Windows x64", files: ["windows-x64.zip"] },
  {
    id: "android",
    label: "Android",
    files: ["android-armeabi-v7a.apk", "android-arm64-v8a.apk", "android-x86_64.apk"],
  },
] as const;

export const targetId = z.enum([
  "linux-x64",
  "linux-arm64",
  "macos-universal",
  "windows-x64",
  "android",
]);
export type TargetId = z.infer<typeof targetId>;
export const buildStatus = z.enum([
  "queued",
  "dispatching",
  "dispatch_unknown",
  "running",
  "publishing",
  "success",
  "partial",
  "failure",
  "cancelled",
  "blocked",
  "timed_out",
]);
export type BuildStatus = z.infer<typeof buildStatus>;
export const terminal = new Set<BuildStatus>([
  "success",
  "partial",
  "failure",
  "cancelled",
  "blocked",
  "timed_out",
]);

export const pullSchema = z.object({
  id: z.string(),
  repositoryId: z.number(),
  fullName: z.string(),
  installationId: z.number(),
  number: z.number(),
  authorId: z.number(),
  authorLogin: z.string(),
  authorTrusted: z.boolean(),
  headSha: z.string(),
  sourceRepo: z.string(),
  baseRef: z.string(),
  baseSha: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  active: z.boolean(),
  closedAt: z.number().nullable(),
  cleanupAt: z.number().nullable(),
  cleaned: z.boolean(),
  cycle: z.number(),
  generation: z.number(),
  latestBuildId: z.string().nullable(),
  commentId: z.number().nullable(),
  commentRef: z.string(),
});
export type Pull = z.infer<typeof pullSchema>;

export const platformSchema = z.object({
  target: targetId,
  status: z.enum(["queued", "running", "built", "ready", "failed", "cancelled"]),
  jobId: z.number().nullable(),
  logUrl: z.string().nullable(),
});
export type Platform = z.infer<typeof platformSchema>;
export const buildSchema = z.object({
  id: z.string(),
  pullId: z.string(),
  repositoryId: z.number(),
  fullName: z.string(),
  installationId: z.number(),
  prNumber: z.number(),
  sourceSha: z.string(),
  sourceRepo: z.string(),
  baseRef: z.string(),
  workflowSha: z.string(),
  generation: z.number(),
  automaticKey: z.string().nullable(),
  actor: z.string().nullable(),
  status: buildStatus,
  runId: z.number().nullable(),
  attempt: z.number(),
  tag: z.string(),
  checkId: z.number().nullable(),
  runUrl: z.string().nullable(),
  createdAt: z.number(),
  dispatchedAt: z.number().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  platforms: z.array(platformSchema),
  error: z.string().nullable(),
  supersededBy: z.string().nullable(),
  replacesSha: z.string().nullable(),
});
export type Build = z.infer<typeof buildSchema>;

export const fileSchema = z.object({
  id: z.string(),
  buildId: z.string(),
  pullId: z.string(),
  target: targetId,
  attempt: z.number(),
  kind: z.enum(["package", "checksum"]),
  filename: z.string(),
  key: z.string(),
  version: z.string().nullable(),
  size: z.number(),
  sha256: z.string(),
  packageId: z.string().nullable(),
  state: z.enum(["staged", "ready", "deleted"]),
});
export type ArtifactFile = z.infer<typeof fileSchema>;
export type User = { id: number; login: string };

/** URL IDs are independent random references, never hashes or storage keys. */
export function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function buildTag(): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

export function filename(source: string, sha: string, tag: string): string {
  const extension = source.endsWith(".tar.gz")
    ? ".tar.gz"
    : source.slice(source.lastIndexOf("."));
  return `pyrite-${source.slice(0, -extension.length)}-${sha.slice(0, 12)}-${tag}${extension}`;
}

export function available(pull: Pull, now: number): boolean {
  return (
    pull.active && !pull.cleaned && (pull.cleanupAt === null || now < pull.cleanupAt)
  );
}

export function canRebuild(user: User, pull: Pull, permission: string): boolean {
  return user.id === pull.authorId || permission === "write" || permission === "admin";
}

export function initialPlatforms(): Platform[] {
  return targets.map(({ id }) => ({
    target: id,
    status: "queued",
    jobId: null,
    logUrl: null,
  }));
}
