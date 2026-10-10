---
status: accepted
---

# Org Admins can transfer a Workspace to another member

A Workspace still has exactly one Owner, but the Owner can now change. An Org Admin (or Super Admin) can hand a Workspace to another member of the Organization through a **Workspace transfer**. Before this, removing a User stranded their Workspaces: Organization access needs membership, every Owner-only action was refused, and deleting the Workspace was the only way out. The trade-off is privacy. Chats may hold personal material, so a transfer puts the old Owner's conversations in front of a specific new person. We accepted that because a Workspace already behaves like a company mailbox: Org Admins create every Workspace (ADR-0008) and can already read every Chat in it, and handing a departing person's mailbox to a successor is ordinary corporate practice. To keep the trade-off deliberate, the Org Admin chooses at transfer time whether the history goes with it.

## Considered Options

- **No transfer; delete or leave the Workspace.** Rejected. It keeps the lowest privacy exposure but throws away a removed User's setup, which is the problem being solved.
- **Only Org Admins may receive a transfer.** Rejected. It adds no new exposure, but turns the Org Admin into the person doing the departed User's work, which defeats the point.
- **Always transfer history.** Rejected in favour of a choice. Handing over a working setup without the previous person's conversations is a legitimate need.
- **A Workspace Owner may give their own Workspace away.** Rejected. Org Admins assign Owners at creation; transfer is the same authority.
- **A "Leave as is" choice when removing a User.** Rejected. Removal must decide every Workspace the User owns, transfer or delete, so none is stranded silently. Workspaces stranded before this ships are fixed from the Workspace's settings.
- **Re-keying the old Owner's Context to the new Owner.** Rejected. A Context describes the person who wrote it, not the Workspace.

## Consequences

- **Who.** Org Admins and Super Admins transfer. The recipient is any member of the Organization who is not banned and is not the current Owner. With no eligible recipient, transfer is unavailable rather than an empty picker; on a single-User install it never applies.
- **Where.** A Transfer action on the Workspace's settings, and the same step inside Remove from Org. Removal lists each Workspace the User owns and requires Transfer or Delete for each. Removal and every choice in it succeed or fail together.
- **History.** Keep (the default) or clear. Keeping moves the old Owner's Memories to the new Owner; they summarise Chats the new Owner now sees anyway. Clearing deletes Chats (with their Attachments, Trigger-run transcripts and A2A Tasks), Memories and Notifications, and keeps Boards, Sandbox files and Dashboards, which are work products and setup rather than conversation.
- **What a run acts as.** Trigger runs, Inbound Trigger calls and A2A calls act as the Owner. So every transfer, whatever the history choice, turns off every Trigger and revokes every Inbound Trigger and A2A token. The new Owner turns on and issues what they want. Nothing starts acting as the new Owner without their choosing it.
- **Personal credentials.** Under ADR-0006 an Owner may have entered their own credentials. A transfer clears MCP OAuth tokens, MCP bearer tokens and the Sandbox's Owner-set environment, and switches off Owner-managed Providers and Owner-managed MCP servers, since that trust was granted to a person. Provider keys stay, because nothing distinguishes an Org Admin's key from an Owner's and clearing them would stop every Agent; the confirm step lists them for review.
- **In-flight work.** Chat turns, Trigger runs and A2A Tasks running at transfer time are cancelled.
- **Unchanged.** The old Owner's Context stays theirs and invisible to the new Owner. Card authorship, assignees and Card history keep naming the old Owner. The runtime check that stops a Workspace acting once its Owner has left the Organization stays, for Workspaces stranded before this ships.
- **Telling people.** The new Owner gets a Notification in the Workspace. Users are told in the docs, up front, that a Workspace belongs to the Organization, that Org Admins can read its Chats, and that it can be transferred with its history.
