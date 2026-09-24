"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { useAuth, useBackendUrl } from "@/components/auth-provider";
import { optionalFetcher, joinUrl } from "@/lib/utils";
import { writeAt } from "@/lib/api-write";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RevealableInput } from "@/components/ui/revealable-input";
import { Label } from "@/components/ui/label";
import { InviteShell } from "../invite-shell";
import { LoadingRegion, SkeletonLine } from "@/components/list-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  InvitationAcceptResult,
  InvitationLinkResolution,
} from "@platypus/schemas";

/**
 * Redeems an invitation link (#549, ADR-0019). Three arrival states,
 * decided by session vs. the invited address:
 *
 * - No session: a registration form with the email fixed (never editable —
 *   it comes from the token, not from what someone types).
 * - Signed in as the invited address: a single Accept action.
 * - Signed in as a different address: refused, with an explanation and a
 *   sign-out offer, and the Invitation stays pending.
 */
export default function InviteTokenPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const {
    user,
    authClient,
    refreshSession,
    isPending: isAuthPending,
  } = useAuth();
  const backendUrl = useBackendUrl();

  // The token lives only in this page's own state after the first render —
  // the URL itself is scrubbed below so a bearer credential doesn't linger
  // in the address bar, browser history, or an outbound referrer header.
  const [redeemToken] = useState(token);

  useEffect(() => {
    window.history.replaceState(null, "", "/invite");
  }, []);

  const { data, error, isLoading } = useSWR<InvitationLinkResolution>(
    backendUrl && redeemToken
      ? joinUrl(backendUrl, `/invitation-links/${redeemToken}`)
      : null,
    optionalFetcher,
  );

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  // Land in the Workspace the accept just provisioned, not the root — for a
  // member of other Organizations "/" may resolve to a different one.
  const enterWorkspace = ({
    organizationId,
    workspaceId,
  }: InvitationAcceptResult) =>
    router.push(`/${organizationId}/workspace/${workspaceId}`);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);
    const outcome = await writeAt<InvitationAcceptResult>(
      joinUrl(backendUrl, `/invitation-links/${redeemToken}/register`),
      { method: "POST", data: { name, password } },
    );
    if (outcome.outcome !== "success") {
      setIsSubmitting(false);
      setFormError(outcome.message);
      if (outcome.outcome === "conflict") {
        setIsSigningIn(true);
        setPassword("");
      }
      return;
    }
    // This endpoint sets cookies outside Better Auth's client. Refresh its
    // session store before navigating into a protected page.
    await refreshSession();
    setIsSubmitting(false);
    enterWorkspace(outcome.data);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      const result = await authClient.signIn.email({
        email: data.email,
        password,
      });
      if (result.error) {
        setFormError(result.error.message || "Sign in failed");
        return;
      }
      // Stay here with the token in memory. The invited-account state below
      // offers Accept after the session refresh, without exposing the URL again.
      await refreshSession();
      setPassword("");
    } catch {
      setFormError("Sign in failed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleAccept = async () => {
    setFormError(null);
    setIsSubmitting(true);
    const outcome = await writeAt<InvitationAcceptResult>(
      joinUrl(backendUrl, `/invitation-links/${redeemToken}/accept`),
      { method: "POST" },
    );
    setIsSubmitting(false);
    if (outcome.outcome !== "success") {
      setFormError(outcome.message);
      return;
    }
    enterWorkspace(outcome.data);
  };

  const handleSignOut = async () => {
    await authClient.signOut();
  };

  if (isLoading || isAuthPending) {
    // Shaped like the registration form, the state a fresh link most often
    // lands on: heading and invite line, then email, name, password, submit.
    return (
      <InviteShell>
        <LoadingRegion label="Loading invitation" className="space-y-8">
          <div className="flex flex-col items-center">
            <SkeletonLine lineClassName="h-8" className="h-6 w-44" />
            <SkeletonLine
              lineClassName="mt-2 h-6"
              className="h-4 w-64 max-w-full"
            />
          </div>
          <div className="space-y-4">
            {["w-10", "w-12", "w-16"].map((width) => (
              <div key={width} className="space-y-2">
                <SkeletonLine lineClassName="h-3.5" className={width} />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
            <Skeleton className="h-9 w-full" />
          </div>
          <div className="flex h-9 items-center justify-center">
            <Skeleton className="h-3.5 w-52" />
          </div>
        </LoadingRegion>
      </InviteShell>
    );
  }

  if (error !== undefined || !data) {
    return (
      <InviteShell className="space-y-4 text-center">
        <h1 className="text-2xl font-bold">Invitation not found</h1>
        <p className="text-muted-foreground">
          This invitation link is not valid. It may have already been used,
          declined, or expired. Ask whoever invited you to send a new one.
        </p>
      </InviteShell>
    );
  }

  // Signed in as someone other than the invited address: refuse, explain,
  // offer sign-out, and leave the Invitation pending (untouched).
  if (user && user.email !== data.email) {
    return (
      <InviteShell className="space-y-4 text-center">
        <h1 className="text-2xl font-bold">Wrong account</h1>
        <p className="text-muted-foreground">
          This invitation to join{" "}
          <span className="font-bold">{data.organizationName}</span> was sent to{" "}
          <span className="font-bold">{data.email}</span>, but you are signed in
          as <span className="font-bold">{user.email}</span>.
        </p>
        <Button onClick={handleSignOut} className="w-full">
          Sign out
        </Button>
      </InviteShell>
    );
  }

  // Signed in as the invited address: a single Accept action.
  if (user && user.email === data.email) {
    return (
      <InviteShell className="space-y-6 text-center">
        <div>
          <h1 className="text-2xl font-bold">You&apos;re invited</h1>
          <p className="text-muted-foreground mt-2">
            Join <span className="font-bold">{data.organizationName}</span> as{" "}
            {data.email}.
          </p>
        </div>
        {formError && (
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
            {formError}
          </div>
        )}
        <Button
          onClick={handleAccept}
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Accepting..." : "Accept invitation"}
        </Button>
      </InviteShell>
    );
  }

  // No session: register or sign in here, retaining the resolved token.
  return (
    <InviteShell className="space-y-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">You&apos;re invited</h1>
        <p className="text-muted-foreground mt-2">
          {isSigningIn ? "Sign in to join " : "Create an account to join "}
          <span className="font-bold">{data.organizationName}</span>.
        </p>
      </div>

      <form
        onSubmit={isSigningIn ? handleSignIn : handleRegister}
        className="space-y-4"
      >
        {formError && (
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
            {formError}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={data.email} disabled readOnly />
        </div>

        {!isSigningIn && (
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <RevealableInput
            id="password"
            placeholder={
              isSigningIn ? "Your password" : "At least 8 characters"
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={isSigningIn ? undefined : 8}
            required
            disabled={isSubmitting}
          />
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting
            ? isSigningIn
              ? "Signing in..."
              : "Creating account..."
            : isSigningIn
              ? "Sign in"
              : "Accept invitation"}
        </Button>
      </form>
      <Button
        variant="link"
        className="w-full"
        disabled={isSubmitting}
        onClick={() => {
          setIsSigningIn(!isSigningIn);
          setFormError(null);
          setPassword("");
        }}
      >
        {isSigningIn
          ? "Need an account? Create one"
          : "Already have an account? Sign in"}
      </Button>
    </InviteShell>
  );
}
