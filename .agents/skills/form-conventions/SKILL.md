---
name: form-conventions
description: Post-save conventions for Platypus frontend forms — where a save lands the user, what the submit button is called, how a failed delete is shown, and the unsaved-changes guard. Use when adding or changing a form in apps/frontend, its submit button, what happens after it saves, or a delete confirm dialog.
---

# Frontend Form Conventions

## Where a save lands

One rule covers every form: **a save returns the user to the entity's home,
and only leaves the page when the form has no home to return to.** Which of
the two applies falls out of the entity's shape in the route tree:

| Shape             | The form is…                                       | On save    | Examples                                                                          |
| ----------------- | -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| Collection member | the entity's page, reached from a list             | go to list | Agents, Blueprints, Skills, Triggers, MCP, Providers, Webhooks, Workspace Context |
| Entity sub-page   | a `settings/` child of a page the entity owns      | stay       | Boards, Dashboards                                                                |
| Singleton         | one per Workspace/Org/account, so there is no list | stay       | Sandbox, Organization, Workspace                                                  |
| Dialog or inline  | not a page at all                                  | stay       | Members, Invitations, Global Context, everything in Chat                          |

Read the shape off `apps/frontend/app`. `settings/agents/[agentId]` renders
the agent edit form — an agent has no detail page, so leaving the form means
returning to `settings/agents`. A board does have a page, and its form lives
at `boards/[boardId]/settings`, so saving keeps you there.

Staying means `mutate()` (or `router.refresh()`) plus a toast. Never
`router.push` to the page you are already on.

**Creating always navigates** — to the new entity where it has a page of its
own, otherwise to the list it now belongs to.

**Deleting always navigates away** from whatever it destroyed, whatever the
shape: to the list for a collection member, to the parent otherwise.

A list is wherever the list actually renders, not a route that looks like one.
Triggers navigate to the Workspace home because that is where the trigger list
lives; there is no `triggers/` page.

## When a delete fails

A refused delete is shown **inline, in the confirm dialog, which stays open**.
The spinner stops and the user can read the message, then retry or cancel.
This holds for every delete, form or list: use `useEntityDelete` or
`useDeleteFlow` and pass the error to the dialog. Never toast a failed delete
and close the dialog.

The one exception is `guidanceOnForbidden`, on both hooks, and it is for
Shared-resource deletes only. Deleting a Shared resource from a Workspace is
refused as `forbidden`, and the message only says where the resource is
managed: guidance, not an error the user can act on in this dialog. With the
option set, a `forbidden` refusal closes the dialog and shows the message as
an info toast. Every other refusal still stays inline.

A dialog's Cancel button is `variant="outline"`, never `ghost`.

## Leaving with unsaved changes

Every form built on `useEntityForm` is guarded for free: while its values
differ from the ones it was seeded or last saved with (`isDirty`), a
same-tab link click opens "Discard unsaved changes?" and refresh or tab
close shows the browser's prompt. Typing then reverting is clean. A
successful save is clean before `onSuccess` runs, so the post-save redirect
goes straight through; a failed save stays dirty.

- A value the form sets itself — a default once options load, a reset after
  save — goes through `seedFormData`, not `setFormData`, or the untouched
  form reads as dirty.
- An edit the form keeps outside `formData` (a selection, raw JSON text, an
  avatar file) goes in `sideState`, or changing it alone never prompts.
- A deliberate full document load after a write uses `hardNavigate`, not
  `window.location.href`, so the browser's prompt doesn't fire over it.
- A surface with its own state and no `useEntityForm` (the Card dialog) calls
  `useUnsavedChangesGuard(isDirty)` and routes its own close through the
  `confirmDiscard` it returns.
- A small dialog or inline action built on `useEntityForm` (member edit,
  chat rename, issue token) passes `guardUnsavedChanges: false`: it is not a
  form the user would lose work in.
- Programmatic navigation (`router.push` after save or delete) and browser
  Back are never held. The App Router cannot block Back.

## What the button says

The label names the outcome, so it follows from the destination:

| Case                            | Label    |
| ------------------------------- | -------- |
| Create, page-level form         | `Save`   |
| Edit that navigates to the list | `Update` |
| Edit saved in place             | `Save`   |
| Adding to a surface you stay on | `Add`    |

`Update` is reserved for the edit-then-leave case — it is the word for a save
you are about to be carried away from. `Add` covers the in-place additions:
`Add column`, `Add card`, `Add widget`.

Let the form heading name the entity and keep the button to the bare verb
(`Save`, not `Create board`). Prefer the bare verb over `Save changes` too. A
loading state keeps the same verb as the button it replaces, with the repo's
ASCII ellipsis: `Saving...` under `Save`, `Updating...` under `Update`.

Unlike the destination rule, this one is ahead of the code. Most forms today
label on `{id ? "Update" : "Save"}` alone, so a stay-in-place edit can still
read `Update` (Sandbox, Organization, Workspace, Dashboard settings); #793
brings the existing buttons into line. Write new buttons to the rule above,
and leave the stragglers to that issue.
