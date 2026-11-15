/** Paper Smart river, seven approved intermediate pages. No dashboard/navigation. */
export type Page =
  | { kind: "login"; pr: number; returnPath: string }
  | { kind: "denied"; login: string; returnPath: string }
  | {
      kind: "download";
      filename: string;
      sha: string;
      platform: string;
      warning: boolean;
      path: string;
      started: boolean;
    }
  | {
      kind: "rebuild";
      pr: number;
      sha: string;
      startedSha?: string;
      path: string;
      confirmation: string;
      started: boolean;
      logUrl: string;
    }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
function heading(emoji: string, title: string, subtitle = "") {
  return (
    `<header class="heading"><div class="emoji" aria-hidden="true">${emoji}</div>` +
    `<h1>${escapeHtml(title)}</h1>${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}</header>`
  );
}
function field(name: string, value: string) {
  return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}
function row(label: string, value: string) {
  return `<div class="row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
}
function oauthForm(csrf: string, path: string, label: string, switchAccount = false) {
  return (
    `<form method="post" action="/builder/oauth/start">${field("csrf", csrf)}` +
    `${field("returnPath", path)}${field("switchAccount", switchAccount ? "1" : "0")}` +
    `<button type="submit">${escapeHtml(label)}</button></form>`
  );
}
function downloadForm(path: string, csrf: string, label: string) {
  return (
    `<form method="post" action="${escapeHtml(path)}" data-task="download">` +
    `${field("csrf", csrf)}<button type="submit">${escapeHtml(label)}</button></form>`
  );
}

export function renderPage(page: Page, csrf = ""): string {
  let content: string;
  let receipt = false;
  switch (page.kind) {
    case "login":
      content =
        heading("🔑", `登陆以重新构建 #${page.pr}`) +
        oauthForm(csrf, page.returnPath, "使用 GitHub 继续 →");
      break;
    case "denied":
      content =
        heading("🚪", "你没有重新构建此 PR 的权限") +
        oauthForm(csrf, page.returnPath, `使用不同于 @${page.login} 的账户重试`, true);
      break;
    case "expired":
      content = heading("🧹", "由于过期，此文件已被清理。");
      break;
    case "error":
      content = heading("🚪", page.message);
      break;
    case "download":
      receipt = page.started;
      content =
        `<section class="stack" data-confirm>${heading("📥", `下载 ${page.filename}`)}` +
        `<div class="panel">${row("提交", page.sha.slice(0, 12))}${row("平台", page.platform)}</div>` +
        (page.warning
          ? `<div class="panel"><p>此文件的安全性未经验证。请谨慎下载。</p></div>`
          : "") +
        `${downloadForm(page.path, csrf, "下载")}</section>` +
        `<section class="stack" data-started hidden>${heading("📥", "下载即将开始")}` +
        `${downloadForm(page.path, csrf, "没有开始？再次下载")}</section>` +
        `<iframe hidden name="download-frame" title="文件下载" data-download-frame></iframe>`;
      break;
    case "rebuild":
      receipt = page.started;
      content =
        `<section class="stack" data-confirm>${heading("🔁", "重新构建这个提交？", `PR #${page.pr}`)}` +
        `<div class="panel">${row("提交", page.sha.slice(0, 12))}</div>` +
        `<form method="post" action="${escapeHtml(page.path)}" data-task="rebuild">` +
        field("csrf", csrf) +
        field("sha", page.sha) +
        field("confirmation", page.confirmation) +
        `<button type="submit">确认 →</button></form></section>` +
        `<section class="stack" data-started hidden>${heading("⌛️", "重新构建已开始")}` +
        `<div class="panel">${row("提交", (page.startedSha ?? page.sha).slice(0, 12))}</div>` +
        `<a class="button" data-log href="${escapeHtml(page.logUrl)}">查看任务日志 →</a></section>`;
      break;
  }
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Pyra</title><link rel="stylesheet" href="/builder/assets/style.css">` +
    `<script src="/builder/assets/page.js" defer></script></head>` +
    `<body data-receipt="${receipt ? "true" : "false"}"><main class="stack">${content}` +
    `<p class="error" role="alert" hidden></p></main></body></html>`
  );
}

export const style = `
:root{color-scheme:light;--canvas:#f7f8fa;--ink:#202329;--muted:#606773;
 --primary:#2463eb;--line:#e7e9ee}
*{box-sizing:border-box}body{margin:0;min-height:100svh;background:var(--canvas);
 color:var(--ink);font-family:system-ui,sans-serif;display:flex;align-items:center;
 justify-content:center;padding:32px 24px}
main{width:min(440px,100%)}.stack{display:flex;flex-direction:column;gap:22px}
.heading{display:flex;flex-direction:column;gap:10px}.emoji{font-size:56px;line-height:76px}
h1{margin:0;font-size:26px;font-weight:700;line-height:39px;overflow-wrap:anywhere}
p{margin:0;font-size:13px;line-height:20px;color:var(--muted)}.subtitle{font-size:13px}
.panel{display:flex;flex-direction:column;gap:16px;background:#fff;border:1px solid var(--line);
 border-radius:12px;padding:20px}.row{display:flex;justify-content:space-between;gap:16px;
 font-size:13px;line-height:20px}.row span:first-child{color:var(--muted)}
.row span:last-child{font-weight:500;overflow-wrap:anywhere;text-align:right}
form{margin:0}button,.button{display:flex;align-items:center;justify-content:center;width:100%;
 min-height:44px;padding:10px 16px;border:0;border-radius:8px;background:var(--primary);
 color:#fff;font-family:inherit;font-size:14px;font-weight:600;line-height:20px;
 text-decoration:none;text-align:center;cursor:pointer;overflow-wrap:anywhere}
button:disabled{opacity:.65;cursor:wait}button:focus-visible,a:focus-visible{outline:3px solid #153c95;
 outline-offset:4px}.error{color:#b93e40}[hidden]{display:none!important}
@media(pointer:coarse){button,.button{min-height:48px;font-size:16px}}
@media(max-height:580px){body{align-items:flex-start}}
`;

export const clientScript = `
const confirm = document.querySelector('[data-confirm]');
const started = document.querySelector('[data-started]');
function showStarted(){
  if(confirm && started){confirm.hidden=true;started.hidden=false;}
}
if(location.hash==='#started'){
  if(document.body.dataset.receipt==='true') showStarted();
  else history.replaceState(null,'',location.pathname+location.search);
}
for(const form of document.querySelectorAll('form[data-task]')){
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=form.querySelector('button');
    const error=document.querySelector('[role=alert]');
    button.disabled=true;error.hidden=true;
    try{
      const response=await fetch(form.action,{method:'POST',
        headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams(new FormData(form)),credentials:'same-origin'});
      const result=await response.json();
      if(!response.ok){
        if(response.status===410){location.reload();return;}
        throw new Error(result.message || '请求未完成，请重试。');
      }
      if(form.dataset.task==='download'){
        document.querySelector('[data-download-frame]').src=result.url;
      }else if(result.url){document.querySelector('[data-log]').href=result.url;}
      document.body.dataset.receipt='true';showStarted();
      history.replaceState(null,'',location.pathname+location.search+'#started');
    }catch(cause){error.textContent=cause.message || '请求未完成，请重试。';error.hidden=false;}
    finally{button.disabled=false;}
  });
}
`;
