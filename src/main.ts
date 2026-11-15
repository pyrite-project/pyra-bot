import { Probot, createNodeMiddleware } from "probot";
import { readConfig } from "./config.js";
import { Database } from "./storage/database.js";
import { GitHubClient } from "./github/client.js";
import { registerWebhooks } from "./github/webhooks.js";
import { B2Objects } from "./artifacts/objects.js";
import { Publisher } from "./artifacts/publisher.js";
import { BuildService } from "./builds/service.js";
import { Feedback } from "./builds/feedback.js";
import { Execution } from "./builds/execution.js";
import { Worker } from "./storage/worker.js";
import { Sessions } from "./web/sessions.js";
import { GitHubOAuth, OAuthFlows } from "./web/oauth.js";
import { createHttp } from "./web/app.js";

const config = readConfig(process.env);
const db = new Database(config.databasePath);
const probot = new Probot({
  appId: config.APP_ID,
  privateKey: config.privateKey,
  secret: config.WEBHOOK_SECRET,
  logLevel: "fatal",
  request: { timeout: 30_000 },
});
const github = new GitHubClient(probot, config.APP_ID);
const objects = new B2Objects(config);
const service = new BuildService(db, github, config);
const feedback = new Feedback(db, github, config.publicUrl);
const publisher = new Publisher(db, github, objects, config);
const execution = new Execution(service, feedback, publisher, objects);
const sessions = new Sessions(db, config.secureCookies);
const oauth = new OAuthFlows(db, config, new GitHubOAuth(config));
const webhook = await createNodeMiddleware(registerWebhooks(service, sessions), {
  probot,
  webhooksPath: "/api/github/webhooks",
});
const http = createHttp(config, service, objects, sessions, oauth, webhook);
const worker = new Worker(service, execution, feedback);
const server = http.listen(config.PORT, () => {
  console.info(JSON.stringify({ event: "listening", port: config.PORT }));
  worker.start();
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await worker.stop();
  db.close();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
