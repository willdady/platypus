# Hiding the Search Toggle When a Web-search Backend Is Missing

Platypus does **not** hide the Chat search toggle (the globe) when the Provider's
`searchSource` names a Web-search backend that is no longer registered. The
toggle's visibility stays a pure function of the Provider row, exactly as
ADR-0014 specifies. The frontend does not fetch the org's installed-backend
catalogue to decide whether to draw the control.

This rejects **the gate**, not the underlying need. A user really should not be
able to ask for a search that cannot run and be told nothing — that is a real
defect, and it is fixed. It is fixed by _reporting_ the dead turn rather than by
_preventing_ it: see [#522](https://github.com/willdady/platypus/issues/522),
which adds a per-turn **Unavailable capability** notice under the reply.

## Why the gate is out of scope

### It contradicts the reason selection is per-Provider

ADR-0014 chose per-Provider `searchSource` over per-Workspace selection, and one
of the stated reasons was that per-Workspace "would split the 'can this Provider
search?' decision across two rows, forcing the toggle-visibility gate to fetch
Workspace state. Per-Provider keeps that gate a pure function of the Provider."

Fetching the org's backend registry to gate the toggle reintroduces exactly the
property that decision paid a design cost to avoid. It is the same coupling
wearing a different scope. The ADR's Selection bullet says the same thing about
the Provider form: the stored id is "**not** validated against the registry
there: the registry is a backend-runtime concern, and a stale id degrades to no
search tools plus a warn-log rather than blocking the form." A gate in Chat is
that validation, moved one screen over.

### It cannot close the window it aims at

The gate is defeated by a race it cannot win. Even with a live catalogue fetch
and correct handling of the not-yet-known state, an Operator can remove the
plugin in the gap between the fetch and the turn being sent. Turn resolution
still has to degrade to no search tools for that turn, and something still has
to report that it did. So the reporting path is required regardless, and once it
exists the gate prevents nothing that is not already handled.

### It addresses one of three causes, and the rarest one

A Chat turn serves no search tools for three distinct reasons:

1. The plugin was removed from `PLATYPUS_PLUGINS` and the Provider still names
   it. Rare — it needs an Operator to remove a plugin that is in use.
2. The backend is installed but its `createExecutors` factory threw or timed
   out. **Common** — this is a self-hosted SearXNG or browser service being
   down, slow, or restarting.
3. The backend is installed but returned no `web_search` executor. Rare — a
   malformed third-party plugin.

Hiding the toggle can only address cause 1. At the moment the UI decides whether
to draw the control, causes 2 and 3 are invisible: the plugin is registered and
looks healthy, and the failure happens later, inside the turn. So the gate
closes the rarest door and cannot touch the most common one.

### It fails in the wrong direction

The gate's failure mode is worse than the bug it fixes. A failed or slow
catalogue request leaves the frontend unsure whether a backend is installed. If
"unknown" hides the toggle, search disappears on Providers where it works
perfectly, and the user has no way to tell why. If "unknown" shows the toggle,
the gate has bought nothing on exactly the turns it was added for. The Provider
form already carries the careful version of this three-state handling, and
reproducing it in Chat is real complexity for a control that is meant to be a
cheap read of one row.

## What we do instead

Report the turn. When a User requests search and Turn resolution builds no
search tools, the turn's message metadata carries a flag and the Chat renders a
one-line notice under the reply saying that search was unavailable. This is the
**Unavailable capability** concept in `CONTEXT.md`.

The reporting path beats the gate on every axis that matters here. It covers all
three causes rather than one, because it tests the outcome ("no search tools were
built") instead of enumerating the reasons. It cannot be defeated by the race,
because it runs inside the turn. It needs no fetch, no cache and no unknown
state. And it leaves a durable record: message metadata is persisted with the
Chat, so anyone reading the transcript later sees that the answer was written
without search.

The three causes stay distinguishable where distinguishing them is actionable —
in the server log, which names the org, the Workspace, the Provider and the
stored `searchSource`, and uses different messages for an unregistered backend,
a failed factory and a missing executor. That reader is the Operator, who is the
only person who can act on the difference.

## What remains open

**Telling the User _why_ search was unavailable.** The notice currently says only
that search did not run. Distinguishing "not configured" (permanent — tell your
Org Admin) from "the search service did not respond" (transient — try again) is
genuinely useful to a user and is a reasonable future request. It is not
rejected; it was deferred from #522 because it re-couples the notice to the three
separate failure sites and gives back the single-site simplicity that made the
outcome-based check attractive. Ask for it as its own enhancement.

**Telling the model.** Rejected on a different ground, and worth recording so it
is not re-proposed as part of a gate. Two shapes were considered: a System prompt
fragment stating that search is unavailable this turn, and a stub `web_search`
Tool that always fails. Both change what the Provider receives, and both key
that change to the health of a third-party service. Several Provider types cache
the prompt prefix automatically, with no opt-in from Platypus — including the
OpenAI-compatible self-hosted servers that are the main users of Web-search
backends. A prefix that flaps with a search backend's uptime is hostile to that
caching, so neither shape is acceptable. The model is not told; only the User is.
