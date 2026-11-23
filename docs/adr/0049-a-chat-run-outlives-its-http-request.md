---
status: accepted
---

# A Chat run outlives its HTTP request

A Chat turn is streamed over the request that started it, but the run is not
bound to that request. The request's abort signal is never handed to the run, so
closing the tab, losing the network or a proxy timeout leaves the run going to
completion; only a cancel (`cancelRun`) or a run timeout stops it. The server
drains its own branch of the teed stream, so the model keeps being pulled while
nobody reads the client branch, and the Chat holds the finished reply for the
User to come back to. Anything written for the client alone, such as the
keepalive heartbeat or a status row, goes on the client branch past the tee,
never on the drained one.

## Considered Options

- **Abort the run when the client disconnects.** Rejected: a long or tool-heavy
  turn would be lost to a flaky connection or a navigation, and the User would
  pay for the tokens it had already spent with nothing to show.
