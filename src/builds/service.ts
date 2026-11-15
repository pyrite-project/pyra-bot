import { z } from "zod";
import type { Config } from "../config.js";
import type { GitHub } from "../github/client.js";
import type { Database } from "../storage/database.js";
import {
  available,
  buildTag,
  canRebuild,
  initialPlatforms,
  opaqueId,
  terminal,
  type Build,
  type Pull,
  type User,
} from "./model.js";

export class RequestFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Own PR identity, authorization, generations, retention, and build acceptance. */
export class BuildService {
  private readonly refreshing = new Map<string, Promise<Pull>>();
  constructor(
    readonly db: Database,
    readonly github: GitHub,
    readonly config: Config,
  ) {}

  allowed(fullName: string) {
    return this.config.repositories.includes(fullName.toLowerCase());
  }

  async refresh(fullName: string, number: number): Promise<Pull> {
    const key = `${fullName.toLowerCase()}/${number}`;
    const current = this.refreshing.get(key);
    if (current) return current;
    const pending = this.refreshNow(fullName, number);
    this.refreshing.set(key, pending);
    try {
      return await pending;
    } finally {
      this.refreshing.delete(key);
    }
  }

  private async refreshNow(fullName: string, number: number): Promise<Pull> {
    if (!this.allowed(fullName)) throw new RequestFailure(404, "此仓库尚未接入 Pyra。");
    const remote = await this.github.pull(fullName, number);
    const id = `${remote.base.repo.id}/${number}`;
    const author = remote.user;
    const permission = author
      ? await this.github.permission(
          remote.installationId,
          fullName,
          author.login,
          author.id,
        )
      : "none";
    const old = this.db.pull(id);
    const reopened = old?.state === "closed" && remote.state === "open";
    const closedAt = remote.closed_at ? Date.parse(remote.closed_at) : null;
    const pull: Pull = {
      id,
      repositoryId: remote.base.repo.id,
      fullName: remote.base.repo.full_name,
      installationId: remote.installationId,
      number,
      authorId: author?.id ?? 0,
      authorLogin: author?.login ?? "ghost",
      authorTrusted: ["write", "admin"].includes(permission),
      headSha: remote.head.sha,
      sourceRepo: remote.head.repo?.full_name ?? fullName,
      baseRef: remote.base.ref,
      baseSha: remote.base.sha,
      state: remote.state,
      merged: remote.merged,
      active: !remote.base.repo.private && this.allowed(remote.base.repo.full_name),
      closedAt,
      cleanupAt:
        remote.state === "closed" && closedAt !== null ? closedAt + 86_400_000 : null,
      cleaned: reopened ? false : (old?.cleaned ?? false),
      cycle: (old?.cycle ?? 0) + (reopened ? 1 : 0),
      generation: old?.generation ?? 0,
      latestBuildId: old?.latestBuildId ?? null,
      commentId: old?.commentId ?? null,
      commentRef: old?.commentRef ?? opaqueId("ref"),
    };
    this.db.savePull(pull);
    if (pull.cleanupAt !== null && !pull.cleaned) {
      this.db.enqueue(
        "cleanup",
        { pullId: id, closedAt },
        `cleanup:${id}:${closedAt}`,
        pull.cleanupAt,
      );
    }
    return pull;
  }

  async synchronize(fullName: string, number: number) {
    const pull = await this.refresh(fullName, number);
    if (!pull.active || pull.state === "closed") {
      for (const build of this.db.activeBuilds(pull.id)) {
        if (
          !terminal.has(build.status) &&
          (!pull.closedAt || build.createdAt <= pull.closedAt)
        ) {
          this.cancel(build, null);
        }
      }
      this.db.enqueue(
        "comment",
        { pullId: pull.id },
        `comment:sync:${opaqueId("event")}`,
      );
      return;
    }
    if (!this.config.baseBranches.includes(pull.baseRef)) {
      await this.accept(
        pull,
        pull.headSha,
        null,
        `untrusted-base:${pull.baseRef}`,
        "目标分支未列入可信构建分支。",
      );
      return;
    }
    try {
      const workflowSha = await this.github.workflow(
        pull.installationId,
        pull.fullName,
        pull.baseRef,
      );
      await this.accept(pull, pull.headSha, null, workflowSha);
    } catch (error) {
      const status = z.object({ status: z.number() }).safeParse(error);
      if (!status.success || ![403, 404].includes(status.data.status)) throw error;
      await this.accept(
        pull,
        pull.headSha,
        null,
        `unavailable:${pull.baseSha}`,
        "目标分支尚无可调度的 Pyra workflow，或 App 缺少读取权限。",
      );
    }
  }

  async authorize(user: User, pull: Pull): Promise<boolean> {
    if (user.id === pull.authorId) return true;
    const permission = await this.github.permission(
      pull.installationId,
      pull.fullName,
      user.login,
      user.id,
    );
    return canRebuild(user, pull, permission);
  }

  /** Confirmation is SHA-bound. Fixed historical commits must already belong to this PR. */
  resolveCommit(pull: Pull, commit: string) {
    if (commit === "latest" || commit === pull.headSha) return pull.headSha;
    if (!/^[a-f0-9]{40}$/.test(commit) || !this.db.knownCommit(pull.id, commit)) {
      throw new RequestFailure(404, "此提交不属于该 PR 的已知构建记录。");
    }
    return commit;
  }

  /** A verified PR comment can bootstrap tracking; its ID makes delivery retries safe. */
  async rebuildFromComment(
    fullName: string,
    number: number,
    user: User,
    commentId: number,
  ) {
    const pull = await this.refresh(fullName, number);
    return this.rebuild(
      pull,
      user,
      "latest",
      pull.headSha,
      `comment:${pull.repositoryId}:${commentId}`,
    );
  }

  async rebuild(
    pull: Pull,
    user: User,
    commit: string,
    expectedSha: string,
    idempotency: string,
  ) {
    if (!available(pull, Date.now()))
      throw new RequestFailure(410, "由于过期，此文件已被清理。");
    if (!(await this.authorize(user, pull)))
      throw new RequestFailure(403, "你没有重新构建此 PR 的权限");
    const source = this.resolveCommit(pull, commit);
    if (source !== expectedSha) throw new RequestFailure(409, "提交已更新，请重新确认。");
    const previous = this.db.get(
      "submission",
      idempotency,
      z.object({ buildId: z.string(), userId: z.number() }),
    );
    if (previous) {
      const build = this.db.build(previous.buildId);
      if (
        previous.userId !== user.id ||
        build?.pullId !== pull.id ||
        build.sourceSha !== source
      ) {
        throw new RequestFailure(409, "此确认请求已用于其他构建。");
      }
      return build;
    }
    const recent = this.db
      .builds(pull.id)
      .filter((b) => b.actor === user.login)
      .some(
        (b) => Date.now() - b.createdAt < this.config.REBUILD_COOLDOWN_SECONDS * 1000,
      );
    if (recent) throw new RequestFailure(429, "请求过于频繁，请稍后重试。");
    if (!this.config.baseBranches.includes(pull.baseRef)) {
      throw new RequestFailure(409, "目标分支尚未配置可信构建。");
    }
    const workflowSha = await this.github.workflow(
      pull.installationId,
      pull.fullName,
      pull.baseRef,
    );
    const build = await this.accept(pull, source, user.login, workflowSha, undefined, {
      key: idempotency,
      userId: user.id,
    });
    return build;
  }

  private async accept(
    pull: Pull,
    sourceSha: string,
    actor: string | null,
    workflowSha: string,
    blocked?: string,
    submission?: { key: string; userId: number },
  ): Promise<Build> {
    const automaticKey = [pull.id, pull.cycle, sourceSha, pull.baseRef, workflowSha].join(
      ":",
    );
    const key = actor ? null : automaticKey;
    const existing = key ? this.db.automatic(key) : null;
    if (existing) return existing;
    const historical = this.db.knownCommit(pull.id, sourceSha);
    const build: Build = {
      id: opaqueId("build"),
      pullId: pull.id,
      repositoryId: pull.repositoryId,
      fullName: pull.fullName,
      installationId: pull.installationId,
      prNumber: pull.number,
      sourceSha,
      sourceRepo:
        sourceSha === pull.headSha
          ? pull.sourceRepo
          : (historical?.sourceRepo ?? pull.sourceRepo),
      baseRef: pull.baseRef,
      workflowSha,
      generation: pull.generation + 1,
      automaticKey: key,
      actor,
      status: blocked ? "blocked" : "queued",
      runId: null,
      attempt: 1,
      tag: buildTag(),
      checkId: null,
      runUrl: null,
      createdAt: Date.now(),
      dispatchedAt: null,
      startedAt: null,
      completedAt: blocked ? Date.now() : null,
      platforms: initialPlatforms(),
      error: blocked ?? null,
      supersededBy: null,
      replacesSha: null,
    };
    return this.db.transaction(() => {
      if (submission) {
        const prior = this.db.get(
          "submission",
          submission.key,
          z.object({ buildId: z.string(), userId: z.number() }),
        );
        if (prior) {
          const accepted = this.db.build(prior.buildId);
          if (
            prior.userId !== submission.userId ||
            accepted?.pullId !== pull.id ||
            accepted.sourceSha !== sourceSha
          )
            throw new RequestFailure(409, "确认请求已使用。");
          return accepted;
        }
      }
      const current = this.db.pull(pull.id);
      if (
        !current ||
        current.headSha !== pull.headSha ||
        current.baseRef !== pull.baseRef ||
        !available(current, Date.now())
      )
        throw new RequestFailure(409, "PR 已更新，请重新确认。");
      build.generation = current.generation + 1;
      // A first manual build already covers this head. A later automatic scan
      // must not create a duplicate and cancel the manually requested build.
      if (sourceSha === current.headSha && !this.db.automatic(automaticKey)) {
        build.automaticKey = automaticKey;
      }
      if (
        sourceSha !== current.headSha &&
        this.db.activeBuilds(pull.id).some((old) => old.sourceSha === current.headSha)
      ) {
        throw new RequestFailure(409, "最新提交正在构建，请在完成后重建历史提交。");
      }
      build.tag = this.db.allocateTag();
      for (const old of this.db.activeBuilds(pull.id)) {
        if (old.sourceSha !== sourceSha) build.replacesSha = old.sourceSha;
        if (!terminal.has(old.status)) this.cancel(old, sourceSha);
      }
      current.generation = build.generation;
      current.latestBuildId = build.id;
      this.db.savePull(current);
      this.db.saveBuild(build);
      if (submission)
        this.db.put("submission", submission.key, {
          buildId: build.id,
          userId: submission.userId,
        });
      this.db.enqueue("feedback", { buildId: build.id }, `feedback:accepted:${build.id}`);
      if (!blocked)
        this.db.enqueue("dispatch", { buildId: build.id }, `dispatch:${build.id}`);
      return build;
    });
  }

  cancel(build: Build, supersededBy: string | null) {
    build.status = "cancelled";
    build.supersededBy = supersededBy;
    build.completedAt = Date.now();
    this.db.saveBuild(build);
    this.db.enqueue(
      "cancel",
      { buildId: build.id },
      `cancel:${build.id}:${build.attempt}`,
    );
    this.db.enqueue(
      "feedback",
      { buildId: build.id },
      `feedback:cancel:${build.id}:${build.attempt}`,
    );
  }
}
