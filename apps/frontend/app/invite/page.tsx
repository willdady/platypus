import { InviteShell } from "./invite-shell";

/**
 * The bare `/invite` address. An invitation page scrubs its token from the
 * address bar once it has resolved it (#549, ADR-0019), so a reload or a
 * restored tab lands here rather than on the invitation it came from.
 */
export default function InvitePage() {
  return (
    <InviteShell className="space-y-4 text-center">
      <h1 className="text-2xl font-bold">Open your invitation link</h1>
      <p className="text-muted-foreground">
        The link you used is no longer in the address bar. Open the invitation
        link you were sent again to continue.
      </p>
    </InviteShell>
  );
}
