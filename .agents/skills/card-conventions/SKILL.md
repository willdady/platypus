---
name: card-conventions
description: Card conventions for Platypus frontend lists. Use when adding or changing a list, card or ⋮ menu in apps/frontend.
---

# Frontend Card Conventions

The Workspace home's Agents, Boards, Dashboards, Triggers and Skills cards are
the reference implementation; a new card list reads the same way.

## What clicking a card opens

**A card opens the item's main view, unless it carries an explicit primary
button.** The primary button is then the card's one action, and the card
itself stays a plain, non-clickable surface.

| Item      | Card click opens                  | Why                                             |
| --------- | --------------------------------- | ----------------------------------------------- |
| Agent     | nothing — **New chat** is primary | the visible button is the main action           |
| Board     | the board                         | its main view                                   |
| Dashboard | the dashboard                     | its main view                                   |
| Trigger   | its runs, filtered to it          | the runs are what a Trigger produces            |
| Skill     | Edit                              | it has no view beyond its settings              |

An item with no view beyond its settings opens Edit. Edit always lives in the
⋮ menu too, so it is reachable from every card.

## The ⋮ menu order

```
Edit
item-specific (Pin, Promote to organization, Manage attachments, …)
Clone
Enable / Disable
───────── separator
Delete
```

Skip the items that do not apply and keep the rest in this order. Delete
takes the destructive style.

Build every list card's (and run row's) ⋮ menu with `RowActionsMenu`
(`components/row-actions-menu.tsx`), never a hand-built `DropdownMenu`; it
enforces the order and the separator.

```tsx
<RowActionsMenu
  name={item.name}                 // "Actions for <name>"
  shared={isShared}                // Edit in org settings + Detach
  edit={{ href }}
  actions={[                       // RowAction: href (a link) or onSelect
    { label: "Pin", icon: <Pin />, onSelect, disabled },
    { label: "View runs", icon: <List />, href },
  ]}
  clone={{ onSelect }}
  toggle={{ enabled, onSelect, disabled }}
  remove={{ onSelect }}            // Delete, or Detach when `shared`
/>
```

Leave out a prop the User lacks the permission for; the component drops the ⋮
when nothing is left, so a list needs no "has menu" check of its own.

## Shared items

A Shared resource attached to a Workspace (`scope: "organization"`) is locked
there. Its card gets a ⋮ menu with:

- **Edit in org settings**, linking to the item in the organization settings,
  only for a User who can manage Shared resources (`canManageSharedResource`);
- the item-specific items that still apply (Pin);
- separator, then **Detach**, in Delete's place.

Pass `shared` to `RowActionsMenu` for both labels.

Detach is always a named menu item that opens the shared Detach dialog
(`DetachSharedDialog`). A Shared card's own click opens its main view if it has
one, and otherwise does nothing. When the User has no items to offer, the card
has no ⋮ button at all.

## Icons and badges

Every action lives in the ⋮ menu, so the card itself carries only content and
badges. A disabled item shows a Disabled badge in its title row — the secondary
`Badge` with the `Pause` icon and the word Disabled, as Trigger cards draw it.

## Card height

Every card in a list is one height, whatever it holds, so a paged list keeps
its height. Reserve line boxes rather than tuning a `min-h` on the card:

- the title row is `min-h-badge`, with or without badges, and the name is
  one line: `truncate`d inside a `min-w-0` `ItemTitle`, with a `title`;
- the description always renders, clamped and reserving the same lines
  (`line-clamp-2 min-h-[2lh]`; `line-clamp-1 min-h-[1lh]` on a card with
  nothing after it, such as a Board's), with `title` holding the full text;
- each line after it is one line tall even when empty (`h-4`), its text
  `truncate`d with a `title`; a list of names becomes a count with a tooltip
  (`CountTooltip`).

The list's skeleton reserves the same boxes, so it lands without a jump.

## Clone

Clone (Agents and Triggers) runs in the browser: send the ordinary create request
with only the fields the create takes, never the item's identity (`id`,
timestamps, `scope`) or its run and token state.

- The clone is named `<name> (copy)`, editable in the Clone dialog.
- Tokens and other issued credentials stay with the original; a clone that
  needs one gets its own.
- A cloned Trigger starts disabled, so it never fires beside its original.
- A cloned Inbound Trigger has no token (`issueToken: false` on the create)
  until the Owner issues one.
- After the create, go to the clone's edit page.
- Use `CloneDialog` (`components/clone-dialog.tsx`) for the dialog.
