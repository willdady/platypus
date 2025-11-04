import { Hono } from 'hono';
import { cors } from 'hono/cors'
import { db } from './index.ts';
import { chat } from './routes/chat.ts';
import { organisation } from './routes/organisation.ts';
import { workspace } from './routes/workspace.ts';
import { agent } from './routes/agent.ts';
import { tool } from './routes/tool.ts';
import { model } from './routes/model.ts';
import { mcp } from './routes/mcp.ts';

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS!.split(',');

type Variables = {
  db: typeof db
};

const app = new Hono<{ Variables: Variables }>();

app.use('/*', cors({
  origin: ALLOWED_ORIGINS
}));

app.use('*', async (c, next) => {
  c.set('db', db);
  await next();
});

app.route('/chat', chat);
app.route('/organisations', organisation);
app.route('/workspaces', workspace);
app.route('/agents', agent);
app.route('/tools', tool);
app.route('/models', model);
app.route('/mcps', mcp);

export default app;