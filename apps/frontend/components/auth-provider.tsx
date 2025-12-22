"use client";

import { createContext, useContext, ReactNode, useMemo } from "react";
import { createAuthClient } from "better-auth/react";

interface AuthContextType {
  user: any | null;
  session: any | null;
  isPending: boolean;
  error: any;
  authClient: ReturnType<typeof createAuthClient>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({
  children,
  backendUrl
}: {
  children: ReactNode;
  backendUrl: string;
}) {
  const authClient = useMemo(() => {
    return createAuthClient({
      baseURL: backendUrl,
      basePath: "/auth",
    });
  }, [backendUrl]);

  const { data, isPending, error } = authClient.useSession();

  return (
    <AuthContext.Provider
      value={{
        user: data?.user ?? null,
        session: data?.session ?? null,
        isPending,
        error,
        authClient,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
