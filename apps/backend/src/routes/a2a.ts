import { Hono } from "hono";
import {
  loadLiveA2aEndpoint,
  publicAgentCard,
} from "../services/a2a-endpoint.ts";
import { authenticateA2aCall } from "../services/a2a-token.ts";
import type { Variables } from "../server.ts";

/**
 * `/a2a/*` — A2A endpoints as outside clients reach them (ADR-0032). Mounted
 * outside `/organizations/...` and outside session auth, so an Operator can
 * expose this prefix alone, as with `/hooks/*`.
 *
 * An endpoint that is unknown, disabled or deleted, whose Workspace the
 * Organization's A2A gate excludes, or whose Owner has left the Organization,
 * is the same `404` with the same body.
 */
const a2a = new Hono<{ Variables: Variables }>();

/** The public Agent Card. Needs no token: the URL is the secret. */
a2a.get("/:endpointId/.well-known/agent-card.json", async (c) => {
  const endpoint = await loadLiveA2aEndpoint(c.req.param("endpointId"));
  if (!endpoint) return c.json({ error: "Not Found" }, 404);
  return c.json(publicAgentCard(endpoint));
});

/**
 * The JSON-RPC interface. Authenticates the token; no method is served yet,
 * so a caller let in gets JSON-RPC's "method not found".
 */
a2a.post("/:endpointId", async (c) => {
  const auth = await authenticateA2aCall(
    c.req.param("endpointId"),
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    if (auth.status === 404) return c.json({ error: "Not Found" }, 404);
    c.header("WWW-Authenticate", "Bearer");
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32601, message: "Method not found" },
  });
});

export { a2a };
