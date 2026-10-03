---
status: accepted
---

# A failed MCP fetch is skipped for 60 s, and every MCP open is bounded at 20 s

ADR-0029 made a failed fetch cheap in tools — the model still sees the MCP's
**Last-known tool listing** — but not in time: every turn still tried the fetch
and waited for it to fail. #1135 put a 20 s bound on that wait, shared with
every Tool set factory, so a hung server cost the turn 20 s on every turn, and a
server that failed fast still cost its round trips (#557 measured +688 ms for
one that failed to authenticate). Two decisions follow, from
[#1105](https://github.com/willdady/platypus/issues/1105).

**Every MCP open is bounded at 20 seconds.** Connect plus `tools/list` on a
turn, the lazy connect a stale tool makes on its first call, and **Test
connection** all give up after #1135's `TOOL_SET_RESOLVE_TIMEOUT_MS`, the same
bound a Tool set factory has, and the client is closed when the connect lands
rather than left running. Test connection had no bound before. A timeout is a
failed fetch like any other, so the skip window below means a hung server costs
20 s once a minute rather than on every turn.

**A failed fetch is skipped for 60 seconds.** The MCP record carries
`lastFetchFailedAt`, set when a turn's fetch or a stale tool's lazy connect
fails — timeout, refused connection, DNS, protocol error, a 5xx, all alike. While
it is under `FETCH_FAILURE_SKIP_WINDOW_MS` old and the MCP has a usable
listing, a turn makes no connect attempt and builds stale tools from the
listing, exactly as ADR-0029's fallback does — through the same conversion, so
they serialise byte-identical to live ones. A successful fetch, lazy connect or
Test connection clears it, as does any edit that clears the listing.

## Considered Options

- **A separate, shorter MCP open timeout (10 s).** Would cut the one turn a
  minute that waits on a hung server, but #1135 chose 20 s to give a cold remote
  server time to accept a connection, refresh an OAuth token and list its tools.
  With the skip window paying for a timeout once a minute, a second constant
  buys little and would treat slow-but-healthy servers as down.
- **Exponential backoff, or counting failures.** Saves more round trips on a
  server that is gone for hours, but adds state and tuning for a cost that is
  already one failed fetch a minute per MCP. A fixed window is predictable: a
  server that comes back is used again within a minute.
- **An environment variable, or a per-MCP setting, for either number.** Nothing
  has asked for it, and both numbers are bounded by what they protect — the
  turn's preparation time and how soon a recovered server is noticed.
- **Hold the failure in process memory.** Per replica, so replicas would
  disagree about whether to try, and a restart forgets it — the reason ADR-0029
  put the listing on the row too.
- **Skip MCPs with no listing as well.** Would drop their tools for the whole
  window instead of for one turn. The skip only ever replaces a fetch whose
  failure would have served the listing anyway; with nothing usable to serve,
  the fetch is always tried.
- **A probe lock, so one turn tries while others wait or skip.** When the window
  expires, concurrent turns may each try the fetch. That is a handful of
  redundant attempts a minute at worst, against a lock that must itself time out
  and be released on every path.

## Consequences

- **An auth failure clears the timestamp rather than setting it.** ADR-0029
  never serves the listing to an MCP that rejects its credentials. Recording one
  would serve its stale tools for the window and drop them after it — flapping
  the very prefix the listing protects — so the next turn fetches again and
  reports the same rejection instead.
- **A server that takes more than 20 s to answer is treated as down** on that
  turn, and its listing is served for the next minute. A server that slow on
  every connect never serves live tools; that is the ceiling of a fixed timeout.
- **A connect that never settles is abandoned, not torn down.** `@ai-sdk/mcp`'s
  `createMCPClient` takes no abort signal, so a server that hangs during
  `initialize` leaves its request open until it settles or the platform's own
  socket timeouts end it; the client is closed if it ever lands. The turn and
  Test connection stop waiting at 20 s either way.
- **Test connection clears only for the saved connection.** A test of unsaved
  edits to the URL, auth or headers says nothing about the stored MCP, so it
  leaves the timestamp alone; saving those edits clears it anyway.
- **Writes are best-effort.** A failed write of `lastFetchFailedAt` is logged and
  ignored, like a failed listing save: it costs at most a skip, or one extra
  fetch.
- **Visibility is a log line.** A skipped fetch logs a warning naming the MCP;
  the timestamp stays out of API output with the listing columns. There is no UI
  signal for an unhealthy MCP.
- **Only a live fetch writes the listing.** A lazy connect moves the timestamp
  but does not re-list.
