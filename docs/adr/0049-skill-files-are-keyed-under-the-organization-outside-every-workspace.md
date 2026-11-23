---
status: accepted
---

# Skill files are keyed under the Organization, outside every Workspace

A bundled Skill file is stored at `{orgId}/skills/{skillId}/{uploadId}/{fileId}`, even when the Skill is scoped to one Workspace. The second segment is the literal `skills` where a File part's key has its Workspace id. Because the Skill sits under its Organization, promoting a Workspace Skill to a Shared one moves no bytes, and deleting the Organization removes its Skills with everything else. Because the second segment is not a Workspace id, the `/files/*` route can't authorize a Skill key the way it does a File part's, so it refuses every Skill key outright, for super admins too. Skill files are served only through their Skill's own download route (ADR-0036). The match on `skills` ignores case, because the disk backend can be case-insensitive and `org/SKILLS/…` reaches the same file.

## Considered Options

- **Key a Workspace Skill under its Workspace (`{orgId}/{workspaceId}/skills/…`).** Rejected: promotion to Shared would have to copy every object to a new prefix, and `/files/*` would read the key as a File part and serve the bundle to the Workspace owner.

## Consequences

- Deleting a Workspace doesn't remove its Skills' bytes by prefix. Each Skill's own prefix has to be deleted.
- Moving to a different layout means migrating every stored Skill object.
