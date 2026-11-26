"use client";

import { AuthShell } from "@/components/auth-shell";
import { appRoutes } from "@/lib/routes";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthClient } from "@/components/auth-provider";
import { useSignUpOpen } from "@/hooks/use-sign-up-open";
import { useInitialFocus } from "@/hooks/use-initial-focus";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { RevealableInput } from "@/components/ui/revealable-input";
import { Label } from "@/components/ui/label";
import Link from "next/link";

export default function SignUpPage() {
  const authClient = useAuthClient();
  const router = useRouter();
  const signUpOpen = useSignUpOpen();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const nameInput = useInitialFocus<HTMLInputElement>();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await authClient.signUp.email({
        email,
        password,
        name,
      });

      if (result.error) {
        setError(result.error.message || "Sign up failed");
        return;
      }

      router.push(appRoutes.home);
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const headingProps =
    signUpOpen === false
      ? {
          title: "Sign-up is by invitation",
          description:
            "This deployment does not accept open sign-ups. Ask an administrator of the Organization you are joining for an invitation link, and open that link to create your account.",
        }
      : signUpOpen
        ? {
            title: "Create an account",
            description: "Sign up to get started with Platypus",
          }
        : {};

  return (
    <AuthShell {...headingProps}>
      {signUpOpen && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              ref={nameInput}
              type="text"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <RevealableInput
              id="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
              disabled={isLoading}
            />
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Creating account..." : "Sign up"}
          </Button>
        </form>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href={appRoutes.signIn} className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
