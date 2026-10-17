"use client";

import { MAIN_CONTENT_ID } from "@/components/skip-link";
import { appRoutes } from "@/lib/routes";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthClient } from "@/components/auth-provider";
import { useSignUpOpen } from "@/hooks/use-sign-up-open";
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

  return (
    <main
      id={MAIN_CONTENT_ID}
      className="flex min-h-screen items-center justify-center"
    >
      <div className="w-full max-w-md space-y-8 p-8">
        {/* The Operator requires an invitation (#550, ADR-0019): say so rather
            than offer a form the backend would refuse. The route stays — a 404
            would read as a broken deployment, not a closed door. */}
        {signUpOpen === false && (
          <div className="text-center">
            <h1 className="text-2xl font-bold">Sign-up is by invitation</h1>
            <p className="text-muted-foreground mt-2">
              This deployment does not accept open sign-ups. Ask an
              administrator of the Organization you are joining for an
              invitation link, and open that link to create your account.
            </p>
          </div>
        )}

        {/* The form waits for the backend to confirm sign-up is open: a form
            that appears and then vanishes is the dead end this avoids. */}
        {signUpOpen && (
          <>
            <div className="text-center">
              <h1 className="text-2xl font-bold">Create an account</h1>
              <p className="text-muted-foreground mt-2">
                Sign up to get started with Platypus
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

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

              <div className="space-y-2">
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

              <div className="space-y-2">
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
          </>
        )}

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            href={appRoutes.signIn}
            className="text-primary hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
