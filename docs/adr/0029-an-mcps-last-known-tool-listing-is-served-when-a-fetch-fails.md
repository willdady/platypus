---
status: accepted
---

# An MCP's last-known tool listing is served when a turn fails to fetch it

Tool definitions render at position 0 of every request (`tools` → `system` →
`messages`), so a tool leaving or joining the list discards the cached System
prompt and the entire transcript along with it — and a flapping MCP pays that
twice, once when its tools leave and again when they return. ADR-0020 stabilised
the System prompt and left this tier volatile. The decision is that each MCP
keeps a **Last-known tool listing** — the raw `tools/list` result from its most
recent successful fetch, persisted on the MCP's own record — and a turn whose
fetch fails serves tools built from it, for up to **24 hours** after that last
successful fetch. A stale tool connects lazily when the model calls it: if the
server is back the call runs, and if not it returns a tool error saying the
server is unreachable. Membership is therefore stable across a blip rather than
restored after it, which is what saves the prefix: a fix that lets a tool leave
and come back is worth roughly half of one that stops it leaving. Originates
from [#635](https://github.com/willdady/platypus/issues/635).

## Considered Options

- **Keep MCP connections open across turns.** Saves connect and list latency, but a pooled connection to a server that is down fails just the same, so it does nothing for membership. It brings idle eviction, reconnect and backoff, OAuth refresh on a long-lived client and a pool per replica, and MCP revision 2026-07-28 removed the protocol sessions that would have made a held connection worth more. Latency was measured separately in #557 and answered by parallelising the Tool session (#776).
- **Drop an unreachable MCP's tools, as before.** Honest about what is available this turn, and the position #522 settled for Web search. But a tool that exists and fails on call is not a silent absence — the failed call is visible to the model and the User at the moment it matters — and the MCP specification now explicitly allows a client to serve a stale `tools/list` result when a re-fetch fails.
- **Pin the tool listing per Chat**, as Anthropic's MCP connector does. Also protects the prefix against a server that legitimately changes its tools mid-Chat, at the cost of new or renamed tools never reaching an existing Chat. Rejected for freshness: nothing shows servers changing their tools often enough to be worth that trade, and serving the stored listing only on failure fixes the defect actually observed.
- **Hold the listing in process memory, or in an `UNLOGGED` table.** Memory is per replica, so two replicas would serve different tool lists for the same MCP, and a restart forgets it. An unlogged table is still a table and a migration, for no gain over a column on the row the listing belongs to.
- **Serve stale definitions indefinitely, or for the server's declared `ttlMs`.** Indefinitely means a server that is genuinely gone offers the model failing tools forever. `ttlMs` is not surfaced by the installed MCP client and describes freshness, not how long to tolerate an outage. A fixed day covers restarts, deploys and overnight outages; dropping after it costs the prefix exactly once.

## Consequences

- **Byte fidelity is the whole point, so the column is `json`, not `jsonb`.** Postgres `jsonb` re-sorts object keys, and tool schemas serialise in insertion order, so a listing read back from `jsonb` would render different bytes from the live one and discard the cache it exists to protect. Stale tools are built through the same definitions-to-tools conversion as live ones, swapping only `execute`, and a test asserts the two serialise identically. The raw listing is what is stored, so the `readOnlyHint` resolution of ADR-0021 reads the same from either.
- **The listing is written only when it changes, or when its fetched-at is over an hour old.** A successful fetch compares the serialised listing with what is stored, so an unchanged turn usually costs no write. Were the timestamp never refreshed, a server whose tools stay the same would lose its day of grace a day after its first fetch, however recently it last answered; refreshing it hourly keeps the window counted from the last successful fetch for at most one write per MCP an hour.
- **Editing an MCP's URL, auth or headers clears its listing.** A different endpoint or credential can mean a different tool list, and the listing belongs to exactly one authorization context — credentials sit on the MCP record, not the User — so sharing it across Users is safe and the specification's `cacheScope: private` concern does not arise.
- **A first turn has nothing to fall back to.** An MCP that has never been fetched successfully, or whose listing is over a day old, still drops its tools as before.
- **Scope is MCP only.** A Web-search backend that yields no tools is a plugin fault already reported on the turn (#522), and a Sub-Agent whose Provider or model fails to resolve is a configuration error that does not recover on its own. Neither is a blip.
- **Not built, and deliberately so.** Skipping the fetch for an MCP that failed recently — which would save the latency #557 measured on a dead server — is a separate decision with its own tuning. Sorting a server's tools by name is not done: the specification asks servers for a deterministic order, and reordering has not been observed.
