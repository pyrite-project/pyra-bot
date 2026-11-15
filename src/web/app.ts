import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Objects } from "../artifacts/objects.js";
import { available, targets } from "../builds/model.js";
import { BuildService, RequestFailure } from "../builds/service.js";
import { rebuildPath } from "../builds/comments.js";
import { Sessions, equal, type Session } from "./sessions.js";
import { OAuthFlows } from "./oauth.js";
import { renderPage, style, clientScript } from "./pages.js";

const paramsSchema = z.object({
  org: z.string().regex(/^[\w.-]+$/),
  repo: z.string().regex(/^[\w.-]+$/),
  pr: z.coerce.number().int().positive(),
  commit: z.string().regex(/^(latest|[a-f0-9]{40})$/),
});

export function createHttp(
  config: Config,
  service: BuildService,
  objects: Objects,
  sessions: Sessions,
  oauth: OAuthFlows,
  webhook?: RequestHandler,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "form-action 'self' https://github.com",
        `frame-src ${new URL(config.B2_ENDPOINT).origin}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    });
    next();
  });
  // Signature verification must see the raw request, before a generic body parser.
  if (webhook) app.use(webhook);
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.get("/healthz", (_req, res) => {
    service.db.sql.prepare("SELECT 1").get();
    res.json({ ok: true });
  });
  app.get("/builder/assets/style.css", (_req, res) => res.type("css").send(style));
  app.get("/builder/assets/page.js", (_req, res) => res.type("js").send(clientScript));

  function csrf(req: Request, session: Session) {
    const token = z.object({ csrf: z.string() }).safeParse(req.body);
    if (
      (req.get("origin") && req.get("origin") !== config.publicUrl) ||
      !token.success ||
      !equal(token.data.csrf, session.csrf)
    ) {
      throw new RequestFailure(403, "请求已失效，请刷新页面后重试。");
    }
  }
  async function file(id: string) {
    const artifact = service.db.file(id);
    if (!artifact || artifact.state !== "ready")
      throw new RequestFailure(410, "由于过期，此文件已被清理。");
    const stored = service.db.pull(artifact.pullId);
    if (!stored) throw new RequestFailure(410, "由于过期，此文件已被清理。");
    const pull = await service.refresh(stored.fullName, stored.number);
    if (!available(pull, Date.now()))
      throw new RequestFailure(410, "由于过期，此文件已被清理。");
    return { artifact, pull };
  }
  async function signed(id: string) {
    const { artifact, pull } = await file(id);
    const seconds =
      pull.cleanupAt === null
        ? 600
        : Math.min(600, Math.floor((pull.cleanupAt - Date.now()) / 1000));
    if (seconds < 1) throw new RequestFailure(410, "由于过期，此文件已被清理。");
    return objects.sign(artifact, seconds);
  }

  app.get("/builder/download/:id", async (req, res) => {
    const id = z
      .string()
      .regex(/^file_[A-Za-z0-9_-]+$/)
      .parse(req.params.id);
    const { artifact, pull } = await file(id);
    if (artifact.kind === "checksum") {
      res.redirect(302, await signed(id));
      return;
    }
    const session = sessions.read(req, res);
    const build = service.db.build(artifact.buildId);
    if (!build) throw new RequestFailure(410, "由于过期，此文件已被清理。");
    const definition = targets.find((p) => p.id === artifact.target)!;
    res.send(
      renderPage(
        {
          kind: "download",
          filename: artifact.filename,
          sha: build.sourceSha,
          platform: definition.label,
          warning: !pull.authorTrusted,
          path: req.path,
          started: Boolean(sessions.started(session, req.path)),
        },
        session.csrf,
      ),
    );
  });
  app.post("/builder/download/:id", async (req, res) => {
    const session = sessions.read(req, res);
    csrf(req, session);
    const id = z
      .string()
      .regex(/^file_[A-Za-z0-9_-]+$/)
      .parse(req.params.id);
    const { artifact } = await file(id);
    if (artifact.kind !== "package")
      throw new RequestFailure(400, "校验文件请使用直接下载链接。");
    const url = await signed(id);
    sessions.receipt(session, req.path);
    if (req.get("accept")?.includes("application/json")) res.json({ url });
    else res.redirect(303, url);
  });

  const rebuild = "/builder/rebuild/:org/:repo/:pr/:commit";
  app.get(rebuild, async (req, res) => {
    const args = paramsSchema.parse(req.params);
    const pull = await service.refresh(`${args.org}/${args.repo}`, args.pr);
    if (!available(pull, Date.now()))
      throw new RequestFailure(410, "由于过期，此文件已被清理。");
    const session = sessions.read(req, res);
    const path = rebuildPath(pull, args.commit);
    if (!session.user) {
      res.send(
        renderPage({ kind: "login", pr: pull.number, returnPath: path }, session.csrf),
      );
      return;
    }
    if (!(await service.authorize(session.user, pull))) {
      if (req.query.error !== "no-permission") {
        res.redirect(303, `${path}?error=no-permission`);
        return;
      }
      res
        .status(403)
        .send(
          renderPage(
            { kind: "denied", login: session.user.login, returnPath: path },
            session.csrf,
          ),
        );
      return;
    }
    const sha = service.resolveCommit(pull, args.commit);
    const receipt = sessions.started(session, path);
    const accepted = receipt?.buildId ? service.db.build(receipt.buildId) : null;
    res.send(
      renderPage(
        {
          kind: "rebuild",
          pr: pull.number,
          sha,
          path,
          confirmation: sessions.confirmation(session, path, sha),
          started: Boolean(accepted),
          startedSha: accepted?.sourceSha,
          logUrl:
            accepted?.runUrl ??
            `https://github.com/${pull.fullName}/pull/${pull.number}/checks`,
        },
        session.csrf,
      ),
    );
  });
  app.post(rebuild, async (req, res) => {
    const args = paramsSchema.parse(req.params);
    const session = sessions.read(req, res);
    csrf(req, session);
    if (!session.user) throw new RequestFailure(401, "请先使用 GitHub 登录。");
    const data = z
      .object({ sha: z.string().regex(/^[a-f0-9]{40}$/), confirmation: z.string() })
      .parse(req.body);
    const pull = await service.refresh(`${args.org}/${args.repo}`, args.pr);
    const path = rebuildPath(pull, args.commit);
    if (!sessions.verifyConfirmation(data.confirmation, session, path, data.sha)) {
      throw new RequestFailure(403, "确认请求已失效，请刷新后重试。");
    }
    const build = await service.rebuild(
      pull,
      session.user,
      args.commit,
      data.sha,
      data.confirmation,
    );
    sessions.receipt(session, path, build.id);
    if (req.get("accept")?.includes("application/json")) {
      res.json({
        url:
          build.runUrl ??
          `https://github.com/${pull.fullName}/pull/${pull.number}/checks`,
      });
    } else res.redirect(303, `${path}#started`);
  });

  app.post("/builder/oauth/start", (req, res) => {
    const session = sessions.read(req, res);
    csrf(req, session);
    const data = z
      .object({ returnPath: z.string().max(512), switchAccount: z.enum(["0", "1"]) })
      .parse(req.body);
    res.redirect(303, oauth.start(session, data.returnPath, data.switchAccount === "1"));
  });
  app.get("/builder/oauth/callback", async (req, res) => {
    const session = sessions.read(req, res);
    const query = z
      .object({ state: z.string().min(30).max(200), code: z.string().min(1).max(300) })
      .parse(req.query);
    const result = await oauth.finish(session, query.state, query.code);
    sessions.login(res, session, result.user);
    res.redirect(303, result.path);
  });

  app.use((_req, res) =>
    res
      .status(404)
      .send(renderPage({ kind: "error", message: "此链接不存在或已失效。" })),
  );
  const errors: ErrorRequestHandler = (error: unknown, req, res, _next) => {
    const code =
      error instanceof RequestFailure
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 503;
    const message =
      error instanceof RequestFailure
        ? error.message
        : code === 400
          ? "请求无效，请检查链接或重新登录。"
          : "服务暂时不可用，请稍后重试。";
    if (code >= 500) {
      const upstream = z.object({ status: z.number() }).safeParse(error);
      console.warn(
        JSON.stringify({
          event: "http_failed",
          status: code,
          operation: req.path.startsWith("/builder/oauth/") ? "oauth" : "builder",
          ...(upstream.success ? { upstreamStatus: upstream.data.status } : {}),
        }),
      );
    }
    if (req.get("accept")?.includes("application/json"))
      res.status(code).json({ message });
    else
      res
        .status(code)
        .send(
          renderPage(code === 410 ? { kind: "expired" } : { kind: "error", message }),
        );
  };
  app.use(errors);
  return app;
}
