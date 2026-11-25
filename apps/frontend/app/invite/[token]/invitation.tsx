"use client";

import { appRoutes, withBasePath, workspaceRoutes } from "@/lib/routes";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import {
  useAuth,
  useAuthClient,
  useBackendUrl,
} from "@/components/auth-provider";
import { optionalFetcher, joinUrl } from "@/lib/utils";
import { scopedUrl, writeAt, type Serialized } from "@/lib/api-write";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

export default function InviteTokenPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { user, refreshSession, isPending: isAuthPending } = useAuth();
  const authClient = useAuthClient();
  const backendUrl = useBackendUrl();
  const { mutate } = useSWRConfig();

  const [redeemToken] = useState(token);

  useEffect(() => {
    window.history.replaceState(null, "", withBasePath(appRoutes.invite));
  }, []);

  const { data, error, isLoading } = useSWR<
    Serialized<InvitationLinkResolution> | null,
    unknown
  >(
    backendUrl && redeemToken
      ? joinUrl(backendUrl, `/invitation-links/${redeemToken}`)
      : null,
    optionalFetcher,
    { onError: () => {} },
  );

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);

  const enterWorkspace = ({
    organizationId,
    workspaceId,
  }: InvitationAcceptResult) =>
    router.push(workspaceRoutes(organizationId, workspaceId).root);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setIsSubmitting(true);
    try {
      const outcome = await writeAt<InvitationAcceptResult>(
        joinUrl(backendUrl, `/invitation-links/${redeemToken}/register`),
        { method: "POST", data: { name, password } },
      );
      if (outcome.outcome !== "success") {
        setFormError(outcome.message);
        if (outcome.outcome === "conflict") {
          setIsSigningIn(true);
          setPassword("");
        }
        return;
      }
      await refreshSession();
      enterWorkspace(outcome.data);
    } finally {
      setIsSubmitting(false);
    }
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
    void mutate(scopedUrl(backendUrl, "organizations", {}));
    enterWorkspace(outcome.data);
  };

  const handleSignOut = async () => {
    await authClient.signOut();
  };

  if (isLoading || isAuthPending) {
    return (
      <InviteShell>
        <LoadingRegion
          label="Loading invitation"
          className="flex flex-col gap-8"
        >
          <div className="flex flex-col items-center">
            <SkeletonLine lineClassName="h-8" className="h-6 w-44" />
            <SkeletonLine
              lineClassName="mt-2 h-6"
              className="h-4 w-64 max-w-full"
            />
          </div>
          <div className="flex flex-col gap-4">
            {["w-10", "w-12", "w-16"].map((width) => (
              <div key={width} className="flex flex-col gap-2">
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
      <InviteShell className="flex flex-col gap-4 text-center">
        <h1 className="text-2xl font-bold">Invitation not found</h1>
        <p className="text-muted-foreground">
          This invitation link is not valid. It may have already been used,
          declined, or expired. Ask whoever invited you to send a new one.
        </p>
      </InviteShell>
    );
  }

  if (user && user.email !== data.email) {
    return (
      <InviteShell className="flex flex-col gap-4 text-center">
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

  if (user && user.email === data.email) {
    return (
      <InviteShell className="flex flex-col gap-6 text-center">
        <div>
          <h1 className="text-2xl font-bold">You&apos;re invited</h1>
          <p className="text-muted-foreground mt-2">
            Join <span className="font-bold">{data.organizationName}</span> as{" "}
            {data.email}.
          </p>
        </div>
        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
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

  return (
    <InviteShell className="flex flex-col gap-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">You&apos;re invited</h1>
        <p className="text-muted-foreground mt-2">
          {isSigningIn ? "Sign in to join " : "Create an account to join "}
          <span className="font-bold">{data.organizationName}</span>.
        </p>
      </div>

      <form
        onSubmit={isSigningIn ? handleSignIn : handleRegister}
        className="flex flex-col gap-4"
      >
        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={data.email} disabled readOnly />
        </div>

        {!isSigningIn && (
          <div className="flex flex-col gap-2">
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

        <div className="flex flex-col gap-2">
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
