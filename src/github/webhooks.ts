import type { ApplicationFunction } from "probot";
import { z } from "zod";
import type { BuildService } from "../builds/service.js";
import type { Sessions } from "../web/sessions.js";

const envelope = z.object({
  action: z.string().optional(),
  number: z.number().optional(),
  repository: z.object({ id: z.number(), full_name: z.string() }).optional(),
  installation: z.object({ id: z.number() }).optional(),
  workflow_run: z
    .object({ id: z.number(), display_title: z.string().optional() })
    .optional(),
  workflow_job: z.object({ run_id: z.number() }).optional(),
  user: z.object({ id: z.number() }).optional(),
  sender: z.object({ id: z.number() }).optional(),
});

const rebuildComment = z.object({
  action: z.literal("created"),
  issue: z.object({ number: z.int().positive(), pull_request: z.object({}) }),
  comment: z.object({
    id: z.int().positive(),
    body: z.string(),
    user: z.object({
      id: z.int().positive(),
      login: z.string(),
      type: z.literal("User"),
    }),
  }),
});

/** Probot verifies signatures. Persist only routing IDs, never the entire payload. */
export function registerWebhooks(
  service: BuildService,
  sessions: Sessions,
): ApplicationFunction {
  return (app) => {
    app.onAny(async ({ id, name, payload }) => {
      const event = envelope.parse(payload);
      const db = service.db;
      if (name === "github_app_authorization" && event.action === "revoked") {
        const user = event.user?.id ?? event.sender?.id;
        if (user) sessions.revoke(user);
        return;
      }
      const repository = event.repository?.full_name;
      db.transaction(() => {
        if (name === "installation" || name === "installation_repositories") {
          if (["deleted", "suspend", "removed"].includes(event.action ?? "")) {
            for (const pull of db.pulls())
              if (pull.installationId === event.installation?.id) {
                pull.active = false;
                db.savePull(pull);
                for (const build of db.builds(pull.id))
                  if (
                    [
                      "queued",
                      "dispatching",
                      "running",
                      "publishing",
                      "dispatch_unknown",
                    ].includes(build.status)
                  ) {
                    service.cancel(build, null);
                  }
              }
          }
          db.enqueue("scan", {}, `delivery:${id}:scan`);
        }
        if (!repository || !service.allowed(repository)) return;
        if (name === "issue_comment") {
          const command = rebuildComment.safeParse(payload);
          if (
            command.success &&
            command.data.comment.body.trim() === "/rebuild" &&
            command.data.comment.user.id === event.sender?.id
          ) {
            const { comment, issue } = command.data;
            db.enqueue(
              "comment-rebuild",
              {
                fullName: repository,
                number: issue.number,
                commentId: comment.id,
                user: { id: comment.user.id, login: comment.user.login },
              },
              `comment-rebuild:${event.repository!.id}:${comment.id}`,
            );
          }
          return;
        }
        if (
          name === "repository" &&
          ["privatized", "deleted", "archived"].includes(event.action ?? "")
        ) {
          for (const pull of db.pulls())
            if (pull.repositoryId === event.repository?.id) {
              pull.active = false;
              db.savePull(pull);
            }
        }
        if (name === "pull_request" && event.number) {
          db.enqueue(
            "pull",
            { fullName: repository, number: event.number },
            `delivery:${id}`,
          );
        }
        const runId = event.workflow_run?.id ?? event.workflow_job?.run_id;
        if ((name === "workflow_run" || name === "workflow_job") && runId) {
          const title = event.workflow_run?.display_title;
          db.enqueue(
            "run",
            {
              runId,
              fullName: repository,
              requestId: title?.startsWith("pyra:") ? title.slice(5) : undefined,
            },
            `delivery:${id}`,
          );
        }
      });
    });
  };
}
