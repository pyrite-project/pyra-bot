import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../storage/database.js";
import type { GitHub } from "../github/client.js";
import { opaqueId, type Build, type Pull } from "./model.js";
import { checkUpdate, marker, renderComment } from "./comments.js";

const digestSchema = z.object({ value: z.string() });
export class Feedback {
  constructor(
    private readonly db: Database,
    private readonly github: GitHub,
    private readonly publicUrl: string,
  ) {}
  async publish(build: Build, pull: Pull) {
    this.db.enqueue(
      "feedback",
      { buildId: build.id },
      `feedback:state:${build.id}:${build.attempt}:${build.status}:${build.platforms.map((p) => p.status).join("-")}`,
    );
    const body = renderComment(
      pull,
      build,
      this.db.files(pull.id, build.id, build.attempt),
      this.publicUrl,
    );
    const update = checkUpdate(build, body);
    const key = `${build.id}:${build.attempt}`;
    const digest = createHash("sha256").update(JSON.stringify(update)).digest("hex");
    if (this.db.get("check-digest", key, digestSchema)?.value !== digest) {
      const checkId = await this.github.check(build, update);
      const current = this.db.build(build.id);
      if (current?.attempt === build.attempt) {
        current.checkId = checkId;
        this.db.saveBuild(current);
        build.checkId = checkId;
        if (current.status !== build.status) {
          this.db.enqueue(
            "feedback",
            { buildId: build.id },
            `feedback:changed:${opaqueId("event")}`,
          );
        }
      }
      this.db.put("check-digest", key, { value: digest });
    }
    const current = this.db.build(build.id);
    if (
      current?.status === build.status &&
      current.attempt === build.attempt &&
      this.db.pull(pull.id)?.latestBuildId === build.id
    )
      await this.comment(pull, body, build.id);
  }
  async comment(pull: Pull, body?: string, expectedBuildId?: string) {
    const current = this.db.pull(pull.id);
    if (!current?.active) return;
    if (expectedBuildId && current.latestBuildId !== expectedBuildId) return;
    const build = current.latestBuildId ? this.db.build(current.latestBuildId) : null;
    const text =
      body ??
      renderComment(
        current,
        build,
        build ? this.db.files(current.id, build.id, build.attempt) : [],
        this.publicUrl,
      );
    const digest = createHash("sha256").update(text).digest("hex");
    if (this.db.get("comment-digest", current.id, digestSchema)?.value === digest) return;
    current.commentId = await this.github.comment(
      current.installationId,
      current.fullName,
      current.number,
      current.commentId,
      marker(current),
      text,
    );
    // HTTP requests can refresh the PR while the API call is pending.
    const latest = this.db.pull(current.id);
    if (latest) {
      latest.commentId = current.commentId;
      this.db.savePull(latest);
    }
    if (latest?.latestBuildId === current.latestBuildId)
      this.db.put("comment-digest", current.id, { value: digest });
    else
      this.db.enqueue(
        "comment",
        { pullId: current.id },
        `comment:changed:${opaqueId("event")}`,
      );
  }
}
