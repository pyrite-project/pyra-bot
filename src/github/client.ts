import type { Probot } from "probot";
import { z } from "zod";
import type { Build } from "../builds/model.js";

const account = z.object({ id: z.number(), login: z.string() });
const repository = z.object({
  id: z.number(),
  full_name: z.string(),
  private: z.boolean(),
});
const prSchema = z.object({
  number: z.number(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  user: account.nullable(),
  closed_at: z.string().nullable(),
  head: z.object({ sha: z.string(), repo: repository.nullable() }),
  base: z.object({ ref: z.string(), sha: z.string(), repo: repository }),
});
export type PullSnapshot = z.infer<typeof prSchema> & { installationId: number };
export const runSchema = z.object({
  id: z.number(),
  run_attempt: z.number(),
  head_sha: z.string(),
  event: z.string(),
  path: z.string(),
  display_title: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
  run_started_at: z.string().nullable(),
  created_at: z.string(),
  actor: z.object({ login: z.string(), type: z.string() }),
});
export type Run = z.infer<typeof runSchema>;
const jobSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string(),
});
export type Job = z.infer<typeof jobSchema>;
const artifactSchema = z.object({
  id: z.number(),
  name: z.string(),
  size_in_bytes: z.number(),
  expired: z.boolean(),
  digest: z.string().nullable().optional(),
});
export type GitHubArtifact = z.infer<typeof artifactSchema>;
export type CheckUpdate = {
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "action_required" | "timed_out";
  summary: string;
};

/** Narrow API seam: no installation credentials leave this adapter. */
export interface GitHub {
  pull(fullName: string, number: number): Promise<PullSnapshot>;
  permission(
    installationId: number,
    fullName: string,
    login: string,
    expectedUserId: number,
  ): Promise<string>;
  workflow(installationId: number, fullName: string, ref: string): Promise<string>;
  dispatch(build: Build): Promise<number>;
  run(installationId: number, fullName: string, id: number): Promise<Run>;
  findRuns(build: Build): Promise<Run[]>;
  jobs(build: Build): Promise<Job[]>;
  artifacts(build: Build): Promise<GitHubArtifact[]>;
  archive(build: Build, artifactId: number): Promise<Response>;
  cancel(build: Build): Promise<void>;
  check(build: Build, update: CheckUpdate): Promise<number>;
  comment(
    installationId: number,
    fullName: string,
    pr: number,
    commentId: number | null,
    marker: string,
    body: string,
  ): Promise<number>;
  openPulls(fullName: string): Promise<number[]>;
}

function parts(fullName: string) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error("Invalid repository name");
  return { owner, repo };
}

function status(error: unknown): number | undefined {
  const parsed = z.object({ status: z.number() }).safeParse(error);
  return parsed.success ? parsed.data.status : undefined;
}

export class GitHubClient implements GitHub {
  constructor(
    private readonly app: Probot,
    private readonly appId: number,
  ) {}
  private async client(installationId: number) {
    return this.app.auth(installationId);
  }

  async pull(fullName: string, number: number): Promise<PullSnapshot> {
    const app = await this.app.auth();
    const installation = await app.request(
      "GET /repos/{owner}/{repo}/installation",
      parts(fullName),
    );
    const installationId = installation.data.id;
    const api = await this.client(installationId);
    const response = await api.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...parts(fullName),
      pull_number: number,
    });
    return { ...prSchema.parse(response.data), installationId };
  }
  async permission(
    installationId: number,
    fullName: string,
    login: string,
    expectedUserId: number,
  ) {
    try {
      const api = await this.client(installationId);
      const response = await api.request(
        "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
        {
          ...parts(fullName),
          username: login,
        },
      );
      // Logins can be renamed and reassigned during a browser session.
      return Number(response.data.user?.id) === expectedUserId
        ? response.data.permission
        : "none";
    } catch (error) {
      if (status(error) === 404) return "none";
      throw error;
    }
  }
  async workflow(installationId: number, fullName: string, ref: string) {
    const api = await this.client(installationId);
    const commit = await api.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      ...parts(fullName),
      ref,
    });
    await api.request("GET /repos/{owner}/{repo}/contents/{path}", {
      ...parts(fullName),
      path: ".github/workflows/pr-build.yml",
      ref: commit.data.sha,
    });
    return commit.data.sha;
  }
  async dispatch(build: Build) {
    const api = await this.client(build.installationId);
    // This API version returns an explicit run ID; never choose the newest run.
    const response = await api.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        ...parts(build.fullName),
        workflow_id: "pr-build.yml",
        ref: build.baseRef,
        inputs: {
          request_id: build.id,
          pr_number: String(build.prNumber),
          source_sha: build.sourceSha,
          workflow_sha: build.workflowSha,
          source_repository: build.sourceRepo,
        },
        headers: { "X-GitHub-Api-Version": "2026-03-10" },
      },
    );
    return z.object({ workflow_run_id: z.number() }).parse(response.data).workflow_run_id;
  }
  async run(installationId: number, fullName: string, id: number) {
    const api = await this.client(installationId);
    return runSchema.parse(
      (
        await api.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
          ...parts(fullName),
          run_id: id,
        })
      ).data,
    );
  }
  async findRuns(build: Build) {
    const api = await this.client(build.installationId);
    const self = await (await this.app.auth()).request("GET /app");
    const slug = z.object({ slug: z.string() }).parse(self.data).slug;
    const response = await api.request(
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
      {
        ...parts(build.fullName),
        workflow_id: "pr-build.yml",
        event: "workflow_dispatch",
        created: `>=${new Date(build.createdAt - 60_000).toISOString()}`,
        per_page: 100,
      },
    );
    return z
      .array(runSchema)
      .parse(response.data.workflow_runs)
      .filter(
        (r) =>
          r.display_title === `pyra:${build.id}` &&
          r.actor.login === `${slug}[bot]` &&
          r.head_sha === build.workflowSha,
      );
  }
  async jobs(build: Build) {
    const api = await this.client(build.installationId);
    const rows = await api.paginate(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
      {
        ...parts(build.fullName),
        run_id: build.runId!,
        attempt_number: build.attempt,
        per_page: 100,
      },
    );
    return z.array(jobSchema).parse(rows);
  }
  async artifacts(build: Build) {
    const api = await this.client(build.installationId);
    return z.array(artifactSchema).parse(
      await api.paginate("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
        ...parts(build.fullName),
        run_id: build.runId!,
        per_page: 100,
      }),
    );
  }
  async archive(build: Build, artifactId: number) {
    const api = await this.client(build.installationId);
    const auth = z
      .object({ token: z.string() })
      .parse(await api.auth({ type: "installation" }));
    const url = `https://api.github.com/repos/${build.fullName}/actions/artifacts/${artifactId}/zip`;
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (response.status !== 302)
      throw new Error("GitHub artifact download is unavailable");
    const location = new URL(response.headers.get("location") ?? "");
    const trusted = [".githubusercontent.com", ".blob.core.windows.net", ".github.com"];
    if (
      location.protocol !== "https:" ||
      location.username ||
      location.password ||
      !trusted.some((suffix) => location.hostname.endsWith(suffix))
    ) {
      throw new Error("Unexpected GitHub artifact download host");
    }
    // Credentials are deliberately not forwarded to the storage redirect.
    const data = await fetch(location, {
      signal: AbortSignal.timeout(600_000),
      redirect: "error",
    });
    if (!data.ok || !data.body) throw new Error("GitHub artifact transfer failed");
    return data;
  }
  async cancel(build: Build) {
    if (!build.runId) return;
    const api = await this.client(build.installationId);
    try {
      await api.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel", {
        ...parts(build.fullName),
        run_id: build.runId,
      });
    } catch (error) {
      if (status(error) !== 409 && status(error) !== 422) throw error;
    }
  }
  async check(build: Build, update: CheckUpdate) {
    const api = await this.client(build.installationId);
    let id = build.checkId;
    if (!id) {
      const response = await api.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        {
          ...parts(build.fullName),
          ref: build.sourceSha,
          check_name: "Pyra / Build PR",
          filter: "all",
          per_page: 100,
        },
      );
      const existing = response.data.check_runs.find(
        (c) =>
          c.external_id === `${build.id}:${build.attempt}` &&
          Number(c.app?.id) === this.appId,
      );
      id = existing ? z.int().positive().parse(Number(existing.id)) : null;
    }
    const common = {
      ...parts(build.fullName),
      name: "Pyra / Build PR",
      status: update.status,
      ...(update.conclusion ? { conclusion: update.conclusion } : {}),
      ...(build.startedAt ? { started_at: new Date(build.startedAt).toISOString() } : {}),
      ...(update.status === "completed"
        ? { completed_at: new Date(build.completedAt ?? Date.now()).toISOString() }
        : {}),
      ...(build.runUrl ? { details_url: build.runUrl } : {}),
      output: { title: "Pyra PR Build", summary: update.summary },
    };
    if (id) {
      await api.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        ...common,
        check_run_id: id,
      });
      return id;
    }
    return z
      .int()
      .positive()
      .parse(
        Number(
          (
            await api.request("POST /repos/{owner}/{repo}/check-runs", {
              ...common,
              head_sha: build.sourceSha,
              external_id: `${build.id}:${build.attempt}`,
            })
          ).data.id,
        ),
      );
  }
  async comment(
    installationId: number,
    fullName: string,
    pr: number,
    commentId: number | null,
    marker: string,
    body: string,
  ) {
    const api = await this.client(installationId);
    if (!commentId) {
      const rows = await api.paginate(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          ...parts(fullName),
          issue_number: pr,
          per_page: 100,
        },
      );
      const existing = rows.find(
        (c) =>
          Number(c.performed_via_github_app?.id) === this.appId &&
          c.body?.includes(marker),
      );
      commentId = existing ? z.int().positive().parse(Number(existing.id)) : null;
    }
    if (commentId) {
      const existing = await api.request(
        "GET /repos/{owner}/{repo}/issues/comments/{comment_id}",
        {
          ...parts(fullName),
          comment_id: commentId,
        },
      );
      if (existing.data.performed_via_github_app?.id !== this.appId) {
        throw new Error("Comment does not belong to Pyra");
      }
      await api.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        ...parts(fullName),
        comment_id: commentId,
        body,
      });
      return commentId;
    }
    return z
      .int()
      .positive()
      .parse(
        Number(
          (
            await api.request(
              "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
              {
                ...parts(fullName),
                issue_number: pr,
                body,
              },
            )
          ).data.id,
        ),
      );
  }
  async openPulls(fullName: string) {
    const installation = await (
      await this.app.auth()
    ).request("GET /repos/{owner}/{repo}/installation", parts(fullName));
    const api = await this.client(installation.data.id);
    const pulls = await api.paginate("GET /repos/{owner}/{repo}/pulls", {
      ...parts(fullName),
      state: "open",
      per_page: 100,
    });
    return pulls.map((p) => p.number);
  }
}
