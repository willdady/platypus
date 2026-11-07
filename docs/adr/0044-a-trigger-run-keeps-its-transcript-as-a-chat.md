---
status: accepted
implemented-by: "#1826"
---

# A Trigger run keeps its Transcript as a Chat

A **Trigger run** writes its **Transcript** as a **Chat**, the way an A2A call
already does for an external caller: a Chat row bound to the run from its
first message, every message the run produced on it, deleted with the run when
Max Runs to Keep prunes it. The Chat is not listed with the Workspace's Chats
in the app; the run detail page is unchanged. The reason is self-improvement:
an Agent reads past runs to refine its Skills and Instructions (#1005), and
unattended runs are the ones nobody else reviewed. A summary cannot carry what
a tool actually returned, so the record has to be the Transcript itself.

ADR-0023 rejected recording payloads on the **Run timeline** because
`trigger_run` is readable by any Workspace member while Provider and MCP
credentials are redacted from them (ADR-0006), so payload capture looked like a
way around that rule. The premise does not hold against a Chat: a Chat's
Transcript already persists every tool input and output, and a Chat is readable
by the same Workspace members today. A headless Chat has an interactive Chat's
readers and exposes nothing an interactive Chat does not. The timeline itself
stays as ADR-0023 left it: shape and duration, never payloads, beside the Chat
rather than replaced by it.

What stays a Chat-turn-only concern: the run's model calls are unchanged, so no
**Transcript summary** and no **Tool-result clearing** happen inside a Trigger
run; this decision is about what is stored, not what is sent. **Memory
extraction** reads a Trigger run's Chat only when its Trigger opts in, default
off, mirroring an A2A endpoint's opt-in; a Trigger run has no User whose
preferences a Memory would capture. The Chat is titled from the Trigger and the
run's start time rather than by a model call, since the Trigger's name is the
title a reader wants and a model call per run is a cost with no reader. A
suppressed run never executed and gets no Chat; a failed or cancelled run keeps
the partial Chat it wrote, which is often the one worth reading.

## Considered Options

- **Record payloads on Run events**, re-opening ADR-0023's rejected option.
  Rejected again: the timeline would grow a second, unbounded message store with
  its own truncation policy, duplicating what a Chat already stores correctly.
- **A new `trigger_run_message` table** rather than a Chat. Rejected: it is a
  Chat's message tree without the name, and the Chats Tool set, the Active-path
  loader and memory extraction would each need a second reader for it.
- **Show the Chat in the sidebar** as A2A Chats are, with a badge. Rejected for
  now: a Cron Trigger firing every few minutes would bury the User's own Chats.
