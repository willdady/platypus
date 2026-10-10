---
status: accepted
---

# A Skill is a stored bundle, and a Sandbox holds only a cache of it

A Skill is a bundle of files: `SKILL.md` plus references, scripts and assets. The database and StorageBackend are its source of truth, not any filesystem. Agents without a Sandbox read bundled text files through a dedicated Tool. Where an Agent has a Sandbox, the bundle is copied into it at `.platypus/skills/<name>/` the first time the Skill is loaded, and rewritten only when the bundle's hash changes. The copy is a cache: Platypus overwrites it, and edits made there are lost. We chose this because Sandboxes are optional (many Agents never need a shell), stopped Sandboxes can't receive pushes, and Skills are per Agent while the Sandbox is per Workspace (ADR-0001).

## Considered Options

- **The Sandbox as the source of truth** (Skills live as folders, as in local harnesses). Rejected: Agents without a Sandbox would lose Skills entirely.
- **Copy into `.agents/skills/` or `.claude/skills/`.** Rejected: nested harnesses such as Claude Code scan those folders and would pick up every Skill (the risk recorded in #333). Users who want that can symlink.
- **Sync every visible Skill at each turn's Preparation.** Rejected: adds latency and writes Skills the Agent never uses.
- **Push to Sandboxes on save.** Rejected: Sandboxes may be stopped, and a Shared Skill would fan out to every attached Workspace with failures to track.
- **Content-addressed storage shared across Skills.** Rejected for now: deleting would need reference counting. Each Skill owns its bytes.

## Consequences

- Assignment controls which Skills an Agent is told about, not what it can read. Any Agent with a shell can read every Skill copied into the Workspace's Sandbox.
- Copies left behind after a Skill is deleted, renamed or unassigned stay in the Sandbox until something clears them.
- Self-improving Skills need an explicit path that writes back to the stored bundle. Editing the Sandbox copy doesn't persist.
- Third-party scripts run with the Workspace's default env vars (ADR-0004).
