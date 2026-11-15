import { targets, type ArtifactFile, type Build, type Pull } from "./model.js";
import type { CheckUpdate } from "../github/client.js";

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function markdown(value: string): string {
  return value.replace(/[\\`*_\[\]<>|\r\n]/g, (c) => `\\${c}`);
}
export function rebuildPath(pull: Pull, commit = "latest"): string {
  return `/builder/rebuild/${pull.fullName}/${pull.number}/${commit}`;
}
export function marker(pull: Pull): string {
  return `<!--pyra-build:ref:${pull.commentRef};ref-->`;
}

/** Render the user's comment copy; file rows come from verified published records. */
export function renderComment(
  pull: Pull,
  build: Build | null,
  files: ArtifactFile[],
  publicUrl: string,
  now = Date.now(),
): string {
  const greeting = "👋 Hi! 我是 Pyra。";
  const sha = build?.sourceSha.slice(0, 12) ?? pull.headSha.slice(0, 12);
  const rebuild = `${publicUrl}${rebuildPath(pull, build?.sourceSha ?? "latest")}`;
  const footer = `<sub>[重新构建](${rebuild})</sub>`;
  let content: string;
  if (pull.cleaned) {
    content = `🧹 这个 PR 的构建成果被自动清理了。\n\n${footer}`;
  } else if (
    !build ||
    ["queued", "dispatching", "dispatch_unknown"].includes(build.status) ||
    (build.status === "running" && build.startedAt === null)
  ) {
    content = build?.actor
      ? `🔁 来自 @${markdown(build.actor)} 的请求，已为 \`${sha}\` 重新触发构建……`
      : build?.replacesSha
        ? `\`${build.replacesSha.slice(0, 12)}\` 的构建已取消，因为推送了新的提交 \`${sha}\`\n\n🔨 我会改为构建最新版本...`
        : `⏳ 提交 \`${sha}\` 已加入构建队列... 将会很快开始`;
  } else if (["running", "publishing"].includes(build.status)) {
    const labels = {
      queued: "⏳ 排队中",
      running: "🔄 构建中",
      built: "✅ 完成",
      ready: "✅ 完成",
      failed: "❌ 失败",
      cancelled: "已取消",
    };
    const rows = targets.map((t) => {
      const platform = build.platforms.find((p) => p.target === t.id);
      return `| ${t.label} | ${labels[platform?.status ?? "queued"]} |`;
    });
    const elapsed = duration(now - (build.startedAt ?? build.createdAt));
    content = [
      `🔨 正在构建 \`${sha}\`...`,
      "| 平台 | 状态 |\n|---|---|",
      rows.join("\n"),
      `<sub>已用时 ${elapsed} · [查看日志](${build.runUrl})</sub>`,
    ].join("\n\n");
  } else if (build.status === "cancelled") {
    content = build.supersededBy
      ? `\`${sha}\` 的构建已取消，因为推送了新的提交 \`${build.supersededBy.slice(0, 12)}\`\n\n🔨 我会改为构建最新版本...`
      : `\`${sha}\` 的构建已取消。`;
  } else if (build.status === "success" || build.status === "partial") {
    const failed = build.platforms.filter((p) => p.status !== "ready").length;
    const headline =
      build.status === "success"
        ? `🎉 \`${sha}\` 构建成功，用时 ${duration((build.completedAt ?? now) - (build.startedAt ?? build.createdAt))}\n\n### 📦 构建成果`
        : `⚠️ \`${sha}\` 在 ${failed} 个平台构建失败`;
    const rows = targets.flatMap((target) =>
      target.files.map((source) => {
        const file = files.find(
          (f) =>
            f.buildId === build.id &&
            f.attempt === build.attempt &&
            f.target === target.id &&
            f.kind === "package" &&
            f.state === "ready" &&
            f.filename.startsWith(
              `pyrite-${source.replace(/\.(tar\.gz|zip|apk)$/, "")}-`,
            ),
        );
        const label =
          target.id === "android" ? `Android ${source.slice(8, -4)}` : target.label;
        const log =
          build.platforms.find((p) => p.target === target.id)?.logUrl ?? build.runUrl;
        if (!file) return `| ${label} | 失败（[日志](${log})） | - | - |`;
        const checksum = files.find(
          (f) => f.packageId === file.id && f.state === "ready",
        );
        if (!checksum) return `| ${label} | 失败（[日志](${log})） | - | - |`;
        const size = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
        return (
          `| ${label} | [${file.filename}](${publicUrl}/builder/download/${file.id}) | ${size} | ` +
          `\`${file.sha256.slice(0, 12)}\` [CHECKSUM](${publicUrl}/builder/download/${checksum.id}) |`
        );
      }),
    );
    const warning = pull.authorTrusted ? "" : "⚠️ 源来自外部，成果未经安全审核。\n\n";
    content =
      `${headline}\n\n${warning}| 平台 | 文件 | 大小 | 校验 (SHA-256) |\n|---|---|---|---|\n` +
      `${rows.join("\n")}\n\n${footer}`;
  } else {
    const log =
      build.runUrl ?? `https://github.com/${pull.fullName}/pull/${pull.number}/checks`;
    content = `❌ \`${sha}\` 构建失败。[查看日志](${log})。\n\n${footer}`;
    if (build.error) content += `\n\n${markdown(build.error)}`;
  }
  if (pull.cleanupAt !== null && !pull.cleaned) {
    const time = new Date(pull.cleanupAt)
      .toISOString()
      .replace("T", " ")
      .replace(".000Z", " UTC");
    const addition = `⌛️ 此 PR 已被合并/关闭，成果将在 ${time} 被自动清理……`;
    content = content.includes(footer)
      ? content.replace(footer, `${addition}\n\n${footer}`)
      : `${content}\n\n${addition}`;
  }
  return `${greeting}\n\n${content}\n\n${marker(pull)}`;
}

export function checkUpdate(build: Build, summary: string): CheckUpdate {
  if (
    ["queued", "dispatching", "dispatch_unknown"].includes(build.status) ||
    (build.status === "running" && build.startedAt === null)
  )
    return { status: "queued", summary };
  if (["running", "publishing"].includes(build.status))
    return { status: "in_progress", summary };
  const conclusion =
    build.status === "success"
      ? "success"
      : build.status === "cancelled"
        ? "cancelled"
        : build.status === "blocked"
          ? "action_required"
          : build.status === "timed_out"
            ? "timed_out"
            : "failure";
  return { status: "completed", conclusion, summary };
}
