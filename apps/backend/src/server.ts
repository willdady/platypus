import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./index.ts";
import { auth } from "./auth.ts";
import { chat } from "./routes/chat.ts";
import { organisation } from "./routes/organisation.ts";
import { workspace } from "./routes/workspace.ts";
import { agent } from "./routes/agent.ts";
import { tool } from "./routes/tool.ts";
import { mcp } from "./routes/mcp.ts";
import { provider } from "./routes/provider.ts";

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS!.split(",");

type Variables = {
  db: typeof db;
  user?: typeof auth.$Infer.Session.user;
  session?: typeof auth.$Infer.Session.session;
};

const app = new Hono<{ Variables: Variables }>();

app.use(
  "/*",
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true, // Important for cookies
  }),
);

// Auth routes - must be before the db middleware
app.on(["POST", "GET"], "/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

app.use("*", async (c, next) => {
  c.set("db", db);
  await next();
});

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/chat", chat);
app.route("/organisations", organisation);
app.route("/workspaces", workspace);
app.route("/agents", agent);
app.route("/tools", tool);
app.route("/mcps", mcp);
app.route("/providers", provider);

export default app;
