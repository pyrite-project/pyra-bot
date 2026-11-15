import { z } from "zod";
import type { Publisher } from "../artifacts/publisher.js";
import type { Objects } from "../artifacts/objects.js";
import type { Run } from "../github/client.js";
import { initialPlatforms, targets, terminal, available, type Build } from "./model.js";
import type { BuildService } from "./service.js";
import type { Feedback } from "./feedback.js";

export class Execution {
  constructor(
    private readonly service: BuildService,
    private readonly feedback: Feedback,
    private readonly publisher: Publisher,
    private readonly objects: Objects,
  ) {}
  private get db() {
    return this.service.db;
  }
  private get github() {
    return this.service.github;
  }

  /** False means quota/concurrency postponed the task, not a failed attempt. */
  async dispatch(id: string): Promise<boolean> {
    const build = this.db.build(id);
    if (!build || build.status !== "queued") return true;
    const pull = await this.service.refresh(build.fullName, build.prNumber);
    if (
      !available(pull, Date.now()) ||
      build.baseRef !== pull.baseRef ||
      (!build.actor && (pull.state === "closed" || pull.headSha !== build.sourceSha))
    ) {
      this.service.cancel(build, pull.headSha !== build.sourceSha ? pull.headSha : null);
      return true;
    }
    const active = this.db
      .activeBuilds()
      .filter((b) =>
        ["dispatching", "dispatch_unknown", "running", "publishing"].includes(b.status),
      );
    if (
      active.length >= this.service.config.MAX_PARALLEL_BUILDS ||
      this.db.dailyDispatches(build.repositoryId) >= this.service.config.DAILY_BUILD_LIMIT
    )
      return false;
    build.status = "dispatching";
    build.dispatchedAt = Date.now();
    this.db.saveBuild(build);
    try {
      build.runId = await this.github.dispatch(build);
      build.status = "running";
    } catch (error) {
      const status = z.object({ status: z.number() }).safeParse(error);
      const rejected =
        status.success && [400, 401, 403, 404, 422].includes(status.data.status);
      build.status = rejected ? "blocked" : "dispatch_unknown";
      build.error = rejected
        ? "无法调度目标分支的工作流，请检查 App 权限和 Actions 配置。"
        : null;
      if (rejected) build.completedAt = Date.now();
    }
    const current = this.db.build(id);
    if (current?.status === "cancelled") {
      current.runId = build.runId;
      current.dispatchedAt = build.dispatchedAt;
      this.db.saveBuild(current);
      if (current.runId) await this.github.cancel(current);
      return true;
    }
    this.db.saveBuild(build);
    await this.feedback.publish(build, pull);
    return true;
  }

  async sync(id: string) {
    const build = this.db.build(id);
    if (!build) return;
    if (
      !build.runId &&
      ["dispatch_unknown", "dispatching", "timed_out", "cancelled"].includes(build.status)
    ) {
      const deadline =
        (build.dispatchedAt ?? build.createdAt) +
        this.service.config.DISPATCH_RESOLUTION_TIMEOUT_SECONDS * 1000;
      let matches: Run[];
      try {
        matches = await this.github.findRuns(build);
      } catch (error) {
        if (terminal.has(build.status) || Date.now() < deadline) throw error;
        matches = [];
      }
      const recovered = this.db.build(id);
      if (!recovered) return;
      if (terminal.has(recovered.status)) {
        // Late runs must not resurrect a replaced or timed-out request.
        for (const match of matches)
          await this.github.cancel({ ...recovered, runId: match.id });
        return;
      }
      if (matches.length !== 1) {
        if (Date.now() >= deadline) {
          build.status = "timed_out";
          build.error = "无法在限定时间内确认构建任务，请重新构建。";
          build.completedAt = Date.now();
          this.db.saveBuild(build);
          for (const match of matches)
            await this.github.cancel({ ...build, runId: match.id });
          await this.feedback.publish(build, this.db.pull(build.pullId)!);
        }
        return; // An uncertain dispatch is never blindly repeated.
      }
      build.runId = matches[0]!.id;
      build.status = "running";
      this.db.saveBuild(build);
    }
    if (!build.runId) return;
    const run = await this.github.run(build.installationId, build.fullName, build.runId);
    if (this.db.build(id)?.status === "cancelled") {
      await this.github.cancel(build);
      return;
    }
    if (
      run.head_sha !== build.workflowSha ||
      run.event !== "workflow_dispatch" ||
      run.path.split("@")[0] !== ".github/workflows/pr-build.yml" ||
      run.display_title !== `pyra:${build.id}`
    ) {
      build.status = "blocked";
      build.error = "实际工作流与已授权的目标分支快照不一致。";
      build.completedAt = Date.now();
      this.db.saveBuild(build);
      await this.github.cancel(build);
      await this.feedback.publish(build, this.db.pull(build.pullId)!);
      return;
    }
    if (build.status === "cancelled") {
      await this.github.cancel(build);
      return;
    }
    if (terminal.has(build.status) && run.run_attempt <= build.attempt) return;
    if (run.run_attempt > build.attempt) {
      build.attempt = run.run_attempt;
      build.tag = this.db.allocateTag();
      build.checkId = null;
      build.platforms = initialPlatforms();
      build.completedAt = null;
      build.error = null;
    }
    build.runUrl = run.html_url;
    build.startedAt =
      run.status !== "queued" && run.run_started_at
        ? Date.parse(run.run_started_at)
        : null;
    build.status = "running";
    const jobs = await this.github.jobs(build);
    if (this.db.build(id)?.status === "cancelled") {
      await this.github.cancel(build);
      return;
    }
    for (const platform of build.platforms) {
      const job = jobs.find((j) => j.name === `pyra-${platform.target}`);
      if (!job) continue;
      platform.jobId = job.id;
      platform.logUrl = job.html_url;
      if (platform.status === "ready") continue;
      platform.status =
        job.status !== "completed"
          ? job.status === "in_progress"
            ? "running"
            : "queued"
          : job.conclusion === "success"
            ? "built"
            : job.conclusion === "cancelled"
              ? "cancelled"
              : "failed";
    }
    this.db.saveBuild(build);
    const pull = await this.service.refresh(build.fullName, build.prNumber);
    if (this.db.build(id)?.status === "cancelled") return;
    if (
      !available(pull, Date.now()) ||
      (!build.actor && (pull.headSha !== build.sourceSha || pull.state === "closed"))
    ) {
      this.service.cancel(build, pull.headSha !== build.sourceSha ? pull.headSha : null);
      return;
    }
    if (run.status !== "completed") {
      await this.feedback.publish(build, pull);
      return;
    }
    if (run.conclusion === "cancelled") {
      this.service.cancel(build, null);
      return;
    }
    build.status = "publishing";
    this.db.saveBuild(build);
    await this.feedback.publish(build, pull);
    const artifacts = await this.github.artifacts(build);
    for (const platform of build.platforms) {
      if (platform.status !== "built") continue;
      const matches = artifacts.filter(
        (a) => a.name === `pyra-${platform.target}-${build.attempt}`,
      );
      if (matches.length !== 1) {
        platform.status = "failed";
        continue;
      }
      await this.publisher.publish(build, platform.target, matches[0]!, async () => {
        const latest = await this.service.refresh(build.fullName, build.prNumber);
        const current = this.db.build(id);
        if (
          !current ||
          current.status === "cancelled" ||
          !available(latest, Date.now()) ||
          (!build.actor &&
            (latest.state === "closed" || latest.headSha !== build.sourceSha))
        ) {
          if (current) this.service.cancel(current, latest.headSha);
          throw new Error("Build no longer eligible for publication");
        }
      });
      if (this.db.build(id)?.status === "cancelled") return;
      platform.status = "ready";
      this.db.saveBuild(build);
      await this.feedback.publish(build, this.db.pull(build.pullId)!);
    }
    for (const p of build.platforms) if (p.status !== "ready") p.status = "failed";
    const ready = build.platforms.filter((p) => p.status === "ready").length;
    build.status =
      ready === targets.length ? "success" : ready > 0 ? "partial" : "failure";
    build.completedAt = Date.now();
    this.db.saveBuild(build);
    await this.feedback.publish(build, this.db.pull(build.pullId)!);
  }

  async publicationFailed(id: string) {
    const build = this.db.build(id);
    if (!build || build.status !== "publishing") return;
    for (const p of build.platforms)
      if (p.status !== "ready") {
        p.status = "failed";
        p.logUrl = `https://github.com/${build.fullName}/runs/${build.checkId}`;
      }
    build.status = build.platforms.some((p) => p.status === "ready")
      ? "partial"
      : "failure";
    build.error = "构建成果准备失败，请重新构建或联系仓库维护者。";
    build.completedAt = Date.now();
    this.db.saveBuild(build);
    this.db.enqueue(
      "feedback",
      { buildId: build.id },
      `feedback:publication-failed:${build.id}:${build.attempt}`,
    );
  }

  /** Recheck close generation before each irreversible version deletion. */
  async cleanup(pullId: string, closedAt: number) {
    let pull = this.db.pull(pullId);
    if (!pull || pull.cleaned) return;
    pull = await this.service.refresh(pull.fullName, pull.number);
    if (
      pull.state !== "closed" ||
      pull.closedAt !== closedAt ||
      pull.cleanupAt === null ||
      pull.cleanupAt > Date.now()
    )
      return;
    for (const file of this.db.files(pullId)) {
      if (file.state === "deleted") continue;
      const current = await this.service.refresh(pull.fullName, pull.number);
      if (current.state !== "closed" || current.closedAt !== closedAt) return;
      if (!file.version) {
        const remote = await this.objects.head(file.key);
        if (remote) {
          if (remote.sha256 !== file.sha256 || remote.size !== file.size) {
            throw new Error("Unexpected object while recovering cleanup");
          }
          file.version = remote.version;
          this.db.saveFile(file);
        }
      }
      await this.objects.remove(file);
      file.state = "deleted";
      this.db.saveFile(file);
    }
    const current = await this.service.refresh(pull.fullName, pull.number);
    if (current.state !== "closed" || current.closedAt !== closedAt) return;
    current.cleaned = true;
    this.db.savePull(current);
    await this.feedback.comment(current);
  }
}
