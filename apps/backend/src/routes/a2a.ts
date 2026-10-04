import { Hono } from "hono";
import {
  loadLiveA2aEndpoint,
  publicAgentCard,
} from "../services/a2a-endpoint.ts";
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

export { a2a };
