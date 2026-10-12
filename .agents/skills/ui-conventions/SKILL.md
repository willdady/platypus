---
name: ui-conventions
description: Which Platypus frontend component a UI state uses, and how it reads — empty states (EmptyCard vs ListState), their icon, title, description and buttons. Use when adding or changing a screen, list or section in apps/frontend that can be empty or fail to load.
---

# Frontend UI Conventions

## Empty states

Every empty state renders through one of two components, picked by what the
empty thing _is_ on the page:

| The empty thing is…                                            | Component                    | Examples                                                                                           |
| -------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| A **screen's** main content: a settings page, a top-level list | `EmptyCard`                  | Providers, MCP, Sandbox, Webhooks, A2A endpoints, Organization Skills, Blueprints, Agents, Members |
| A **section** within a page, or a list **filtered** to nothing | `ListState variant="empty"`  | Workspace home Skills / Dashboards / Boards / Triggers, "No skills match your filters", A2A tokens |
| A picker or command list inside a popover                      | `CommandEmpty`               | Command menu, timezone and model pickers                                                           |
| A widget tile with no data                                     | the widget's own placeholder | "No data yet" in dashboard widgets                                                                 |

The same list can take both: `SkillsList` shows `EmptyCard` on the
Organization Skills screen and `ListState` inside the workspace home section.
A `border-dashed` div in a diff is the tell of a hand-rolled empty state;
route it through one of the two components instead.

A screen that **failed to load** uses `EmptyCard` too, titled
`Couldn't load …` (trigger runs, plugins, `FetchErrorNotice`). A list's read
failure is `ListError`, which stays unbordered because it also renders inside
dialogs and chat.

### EmptyCard

`components/empty-card.tsx`: `icon`, `title`, `description`, `action`.

- **Icon**: the bare Lucide icon the sidebar uses for that screen
  (`lib/settings-links.ts`, `components/org-settings-menu.tsx`), no size
  class (the frame sizes it). A concept keeps one icon everywhere it appears;
  MCP is `Wrench`, even on the Organization surface.
- **Title**: `No X configured` for things you set up or connect (providers,
  MCP servers, sandbox, webhooks, endpoints); `No X yet` for things users
  author or that accumulate (skills, blueprints, agents, invitations, runs).
  No trailing period.
- **Description**: what the thing is for, or why you'd want one. It adds to
  the title rather than restating it. At Organization scope, say where it
  goes next: "Add a provider here, then attach it to the workspaces that
  should use it."
- **Action**: the buttons that fill the gap, main one first with the default
  (solid) variant, the rest `outline` (Attach shared, Import). The same
  buttons render once: inside the card while the list is empty, below the
  list (all `outline`) once it has rows. Build them as one `actions` element
  and place it by emptiness — see `resource-list.tsx`, `skills-list.tsx`.
- **Read-only viewer**: no button, and the description names who can act —
  "Ask an organization admin to add one." for admin-gated resources, "Only
  the workspace owner can add one." for Owner-only ones (Org Admins see other
  Workspaces read-only). A card with nothing to do, like Organization Agents
  (shared agents only arrive by Promote), explains how one arrives instead.

### ListState

One short line in the same dashed frame: `No dashboards yet.`,
`No Cron triggers to show.` The section's buttons sit below it, so the line
states the fact and leaves the instruction to the buttons.

## Button verbs

An entry button (the one that starts the create flow) says `Add` for things
you connect to and `Create` for things you author:

| Verb     | For                                                                   |
| -------- | --------------------------------------------------------------------- |
| `Add`    | provider, MCP server, webhook, endpoint, workspace, workspace context |
| `Create` | agent, skill, blueprint, board, dashboard, trigger, organization      |

Name the noun in full (`Add MCP server`). The form's own submit button
follows `form-conventions`.
