import type { Metadata } from "next";
import { AuthShell } from "@/components/auth-shell";

export const metadata: Metadata = { title: "Invitation" };

export default function InvitePage() {
  return (
    <AuthShell title="Open your invitation link" className="gap-4 text-center">
      <p className="text-muted-foreground">
        The link you used is no longer in the address bar. Open the invitation
        link you were sent again to continue.
      </p>
    </AuthShell>
  );
}
