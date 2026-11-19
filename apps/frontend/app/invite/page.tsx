import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";

export const metadata: Metadata = { title: "Invitation" };

/**
 * The bare `/invite` address. An invitation page scrubs its token from the
 * address bar once it has resolved it (#549, ADR-0019), so a reload or a
 * restored tab lands here rather than on the invitation it came from.
 */
export default function InvitePage() {
  return (
    <AuthShell
      title="Open your invitation link"
      description="The link you used is no longer in the address bar. Open the invitation link you were sent again to continue."
      className="flex flex-col gap-4"
      headingClassName="flex flex-col gap-4"
    />
  );
}
