import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { RequestFailure, type BuildService } from "../builds/service.js";
import type { Execution } from "../builds/execution.js";
import type { Feedback } from "../builds/feedback.js";
import { terminal } from "../builds/model.js";

const buildPayload = z.object({ buildId: z.string() });

export class Worker {
  private stopping = false;
  private loop: Promise<void> | null = null;
  private minute = -1;
  private hour = -1;
  constructor(
    private readonly service: BuildService,
    private readonly execution: Execution,
    private readonly feedback: Feedback,
  ) {}

  start() {
    this.service.db.enqueue("scan", {}, `startup:${Date.now()}`);
    this.loop = this.work();
  }
  async stop() {
    this.stopping = true;
    await this.loop;
  }
  private async work() {
    while (!this.stopping) {
      this.reconcile();
      if (!(await this.runOne()))
        await pause(this.service.config.TASK_POLL_SECONDS * 1000);
    }
  }
  reconcile() {
    const now = Date.now(),
      minute = Math.floor(now / 60_000),
      hour = Math.floor(now / 3_600_000);
    if (hour !== this.hour) {
      this.hour = hour;
      this.service.db.enqueue("scan", {}, `hourly:${hour}`);
    }
    if (minute === this.minute) return;
    this.minute = minute;
    const db = this.service.db;
    for (const build of db.activeBuilds())
      if (!terminal.has(build.status)) {
        db.enqueue(
          build.status === "queued" ? "dispatch" : "sync",
          { buildId: build.id },
          `reconcile:${minute}:${build.id}`,
        );
      }
    for (const pull of db.pulls()) {
      if (pull.cleanupAt !== null && pull.cleanupAt <= now && !pull.cleaned) {
        db.enqueue(
          "cleanup",
          { pullId: pull.id, closedAt: pull.closedAt },
          `cleanup-recovery:${minute}:${pull.id}`,
        );
      }
      if (pull.active) {
        db.enqueue(
          "pull",
          { fullName: pull.fullName, number: pull.number },
          `pull-recovery:${minute}:${pull.id}`,
        );
        db.enqueue(
          "comment",
          { pullId: pull.id },
          `feedback-recovery:${minute}:${pull.id}`,
        );
        if (pull.latestBuildId)
          db.enqueue(
            "feedback",
            { buildId: pull.latestBuildId },
            `check-recovery:${minute}:${pull.id}`,
          );
      }
    }
    db.sql
      .prepare(`DELETE FROM tasks WHERE done=1 AND run_at<?`)
      .run(now - 7 * 86_400_000);
    db.sql
      .prepare(
        `DELETE FROM records WHERE kind IN ('session','oauth','confirmation')
      AND json_extract(data,'$.expiresAt')<?`,
      )
      .run(now);
  }

  /** Exposed as a bounded unit of work for recovery/lease tests, without starting a daemon. */
  async runOne(): Promise<boolean> {
    const db = this.service.db,
      task = db.claim();
    if (!task) return false;
    const lease = setInterval(() => db.renew(task.id), 30_000);
    lease.unref();
    try {
      const data: unknown = JSON.parse(task.payload);
      switch (task.type) {
        case "scan":
          for (const fullName of this.service.config.repositories) {
            db.enqueue(
              "scan-repository",
              { fullName },
              `scan-repository:${task.id}:${fullName}`,
            );
          }
          break;
        case "scan-repository": {
          const { fullName } = z.object({ fullName: z.string() }).parse(data);
          for (const number of await this.service.github.openPulls(fullName)) {
            db.enqueue(
              "pull",
              { fullName, number },
              `scan:${task.id}:${fullName}:${number}`,
            );
          }
          break;
        }
        case "pull": {
          const p = z.object({ fullName: z.string(), number: z.number() }).parse(data);
          await this.service.synchronize(p.fullName, p.number);
          break;
        }
        case "comment-rebuild": {
          const command = z
            .object({
              fullName: z.string(),
              number: z.int().positive(),
              commentId: z.int().positive(),
              user: z.object({ id: z.int().positive(), login: z.string() }),
            })
            .parse(data);
          try {
            await this.service.rebuildFromComment(
              command.fullName,
              command.number,
              command.user,
              command.commentId,
            );
          } catch (error) {
            if (!(error instanceof RequestFailure)) throw error;
            // Permission, expiry and cooldown rejections must not become
            // delayed build requests through the generic task retry policy.
            console.info(
              JSON.stringify({
                event: "rebuild_comment_rejected",
                commentId: command.commentId,
                status: error.status,
              }),
            );
          }
          break;
        }
        case "dispatch": {
          const p = buildPayload.parse(data);
          if (!(await this.execution.dispatch(p.buildId))) {
            db.defer(task);
            return true;
          }
          break;
        }
        case "sync":
          await this.execution.sync(buildPayload.parse(data).buildId);
          break;
        case "run": {
          const p = z
            .object({
              runId: z.number(),
              fullName: z.string(),
              requestId: z.string().optional(),
            })
            .parse(data);
          const build = db.byRun(p.runId) ?? (p.requestId ? db.build(p.requestId) : null);
          if (build && build.fullName.toLowerCase() === p.fullName.toLowerCase()) {
            await this.execution.sync(build.id);
          } else
            for (const uncertain of db.activeBuilds()) {
              if (["dispatching", "dispatch_unknown"].includes(uncertain.status))
                await this.execution.sync(uncertain.id);
            }
          break;
        }
        case "feedback": {
          const build = db.build(buildPayload.parse(data).buildId);
          const pull = build ? db.pull(build.pullId) : null;
          if (build && pull?.active) await this.feedback.publish(build, pull);
          break;
        }
        case "comment": {
          const pull = db.pull(z.object({ pullId: z.string() }).parse(data).pullId);
          if (pull) await this.feedback.comment(pull);
          break;
        }
        case "cancel": {
          const build = db.build(buildPayload.parse(data).buildId);
          if (build) await this.service.github.cancel(build);
          break;
        }
        case "cleanup": {
          const p = z.object({ pullId: z.string(), closedAt: z.number() }).parse(data);
          await this.execution.cleanup(p.pullId, p.closedAt);
          break;
        }
        default:
          throw new Error("Unknown persisted task type");
      }
      db.complete(task.id);
    } catch {
      if (task.type === "sync" || task.type === "run") {
        if (task.attempts >= 8) {
          const payload = z
            .object({ buildId: z.string().optional(), runId: z.number().optional() })
            .safeParse(JSON.parse(task.payload));
          const buildId = payload.success
            ? (payload.data.buildId ??
              (payload.data.runId ? db.byRun(payload.data.runId)?.id : undefined))
            : undefined;
          if (buildId) await this.execution.publicationFailed(buildId);
        }
      }
      // Do not persist provider exceptions: they may contain signed URLs or credentials.
      db.retry(task, "Task failed; retry policy applied");
      console.warn(
        JSON.stringify({
          event: "task_failed",
          type: task.type,
          id: task.id,
          attempt: task.attempts,
        }),
      );
    } finally {
      clearInterval(lease);
    }
    return true;
  }
}
