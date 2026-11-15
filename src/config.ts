import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const number = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const envSchema = z.object({
  APP_ID: z.coerce.number().int().positive(),
  PRIVATE_KEY_PATH: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(20),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  PUBLIC_URL: z.url(),
  GITHUB_REPOSITORIES: z.string().min(1),
  BUILD_BASE_BRANCHES: z.string().min(1),
  DATABASE_PATH: z.string().default("data/pyra.sqlite"),
  TEMP_DIRECTORY: z.string().default("data/tmp"),
  PORT: number(3000),
  B2_ENDPOINT: z.url(),
  B2_REGION: z.string().min(1),
  B2_BUCKET: z.string().min(1),
  B2_PREFIX: z.string().default("pr-builds"),
  B2_UPLOAD_KEY_ID: z.string().min(1),
  B2_UPLOAD_KEY: z.string().min(1),
  B2_READ_KEY_ID: z.string().min(1),
  B2_READ_KEY: z.string().min(1),
  B2_DELETE_KEY_ID: z.string().min(1),
  B2_DELETE_KEY: z.string().min(1),
  MAX_ARCHIVE_BYTES: number(2_147_483_648),
  MAX_FILE_BYTES: number(1_073_741_824),
  MAX_PARALLEL_BUILDS: number(2),
  DAILY_BUILD_LIMIT: number(50),
  REBUILD_COOLDOWN_SECONDS: number(600),
  DISPATCH_RESOLUTION_TIMEOUT_SECONDS: number(900),
  TASK_POLL_SECONDS: number(5),
});

/** Validate deployment configuration before opening a listener or worker. */
export function readConfig(env: NodeJS.ProcessEnv) {
  const value = envSchema.parse(env);
  const publicUrl = new URL(value.PUBLIC_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !(local && publicUrl.protocol === "http:")) {
    throw new Error("PUBLIC_URL must use HTTPS, except on loopback for local checks");
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin without a path, query, or fragment");
  }
  if (new URL(value.B2_ENDPOINT).protocol !== "https:") {
    throw new Error("B2_ENDPOINT must use HTTPS");
  }
  const repositories = value.GITHUB_REPOSITORIES.split(",").map((s) =>
    s.trim().toLowerCase(),
  );
  if (repositories.some((s) => !/^[\w.-]+\/[\w.-]+$/.test(s))) {
    throw new Error("GITHUB_REPOSITORIES must contain comma-separated owner/repo names");
  }
  const baseBranches = value.BUILD_BASE_BRANCHES.split(",").map((s) => s.trim());
  if (baseBranches.some((s) => !s || /[\s~^:?*\[\\]/.test(s))) {
    throw new Error("BUILD_BASE_BRANCHES contains an invalid branch name");
  }
  return {
    ...value,
    publicUrl: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    privateKey: readFileSync(value.PRIVATE_KEY_PATH, "utf8"),
    databasePath: resolve(value.DATABASE_PATH),
    tempDirectory: resolve(value.TEMP_DIRECTORY),
    repositories,
    baseBranches,
  };
}
export type Config = ReturnType<typeof readConfig>;
