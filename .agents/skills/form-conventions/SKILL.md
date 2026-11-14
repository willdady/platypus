---
name: form-conventions
description: Post-save conventions for Platypus frontend forms — where a save lands the user, what toasts on success, how a failed save is shown, what the submit button is called, how a failed delete is shown, and the unsaved-changes guard. Use when adding or changing a form in apps/frontend, its submit button, what happens after it saves, the feedback a save or delete gives, or a dialog's Cancel button.
---

# Frontend Form Conventions

## Where a save lands

One rule covers every form: **a save returns the user to the entity's home,
and only leaves the page when the form has no home to return to.** Which of
the two applies falls out of the entity's shape in the route tree:

| Shape             | The form is…                                       | On save    | Examples                                                                          |
| ----------------- | -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| Collection member | the entity's page, reached from a list             | go to list | Agents, Blueprints, Skills, Triggers, MCP, Providers, Webhooks, Workspace Context |
| Entity sub-page   | a `settings/` child of a page the entity owns      | stay       | Boards                                                                            |
| Singleton         | one per Workspace/Org/account, so there is no list | stay       | Sandbox, Organization, Workspace                                                  |
| Dialog or inline  | not a page at all                                  | stay       | Members, Invitations, Global Context, everything in Chat                          |

Read the shape off `apps/frontend/app`. `settings/agents/[agentId]` renders
the agent edit form — an agent has no detail page, so leaving the form means
returning to `settings/agents`. A board does have a page, and its form lives
at `boards/[boardId]/settings`, so saving keeps you there.

Staying means `mutate()` (or `router.refresh()`) plus a `successMessage`
toast. Never `router.push` to the page you are already on.

**Every save and delete toasts success, even when it navigates away.**
Arriving on the list is not feedback enough. Pass `successMessage` to
`useEntityForm` and `useEntityDelete`, naming the outcome: `"<Entity>
created"` / `"<Entity> updated"` on a save, `"<Entity> deleted"` on a
delete. Use a function when create and edit differ, as the Webhook form
does. `onSuccess` keeps only the navigation, refresh and side effects; do
not hand-call `toast.success` there. The one exception is a Provider draft
staged inside the setup wizard: the wizard advancing is the feedback, so
its `successMessage` is unset while it runs as a draft.

**Creating always navigates** — to the new entity where it has a page of its
own, otherwise to the list it now belongs to.

**Deleting always navigates away** from whatever it destroyed, whatever the
shape: to the list for a collection member, to the parent otherwise.

A list is wherever the list actually renders, not a route that looks like one.
Triggers navigate to the Workspace home because that is where the trigger list
lives; there is no `triggers/` page.

## When a save fails

A rejected save that maps to fields sets those field errors inline **and**
toasts "please fix the errors" (`FIX_FORM_ERRORS_MESSAGE`). That is
`useEntityForm`'s default, so a page-level form needs nothing; a field can
be scrolled out of view, and the toast is what tells the reader why nothing
happened.

Every dialog or inline action built on `useEntityForm` passes
`invalidMessage: null` instead: its field errors are already in view, so a
toast would only repeat them. That covers member edit, transfer workspace,
the change-password dialog, issuing an A2A token, the Global Context
editor, chat rename and `OrgGateAccess`. A dialog that shows a refusal in
the dialog itself (the A2A regenerate confirm) uses `onInvalid` instead;
the message is then already in view. A short settings page
(change password, profile, sandbox) is still page-level and keeps the
default.

Any other failure — a fieldless 400, `forbidden`, `notFound`, or `error` —
toasts the backend's message. `useEntityForm` does that by default; leave
`onError` alone unless the form has its own guidance rule.

The one inline exception is a `conflict` whose message names the records
blocking the save: render it in a destructive `Alert` at the top of the
form. Today that is only the Provider form, through `onConflict`. Every
other failure of that form still toasts.

## When a delete fails

A refused delete is shown **inline, in the confirm dialog, which stays open**.
The spinner stops and the user can read the message, then retry or cancel.
This holds for every delete, form or list: use `useEntityDelete` or
`useDeleteFlow` and spread its `dialogProps` onto the dialog, which carries the
open state, the confirm handler, the pending flag and the inline error. Never
toast a failed delete and close the dialog.

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

## How the form submits

Every entity form is a real `<form>` whose `onSubmit` runs the same save the
footer button does: `preventDefault()`, then the form's submit. The footer
passes `type="submit"` to `FormFooterButtons`, so Enter in any single-line
field saves once.

- Give every other button inside the form an explicit `type="button"` —
  Advanced settings, reveal/copy, Add model, Test connection, Regenerate,
  and a draft step's Back/Next. An untyped `Button` defaults to submit.
- A draft step in the Workspace wizard keeps its own Back/Next buttons and
  steps through `draft.write`; the wizard must not save twice.
- A dialog that renders its own `<form>` (the Add/Edit model dialog) stops
  the submit event, because React bubbles it through the portal to the
  surrounding form.
- A search field must not submit the form around it.
- Set `noValidate` on the form. The shared schemas own validation and their
  messages, so the browser's step/type bubbles must not block a save.

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
`Add column`, `Add card`.

Let the form heading name the entity and keep the button to the bare verb
(`Save`, not `Create board`). Prefer the bare verb over `Save changes` too. A
loading state keeps the same verb as the button it replaces, with the repo's
ASCII ellipsis: `Saving...` under `Save`, `Updating...` under `Update`.

Unlike the destination rule, this one is ahead of the code. Most forms today
label on `{id ? "Update" : "Save"}` alone, so a stay-in-place edit can still
read `Update` (Sandbox, Organization, Workspace); #793
brings the existing buttons into line. Write new buttons to the rule above,
and leave the stragglers to that issue.
