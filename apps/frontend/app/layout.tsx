import { SkipLink } from "@/components/skip-link";
import { withBasePath } from "@/lib/routes";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getEnv } from "@/lib/env";
import { APP_NAME } from "@/lib/page-title";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/components/auth-provider";
import { MotionProvider } from "@/components/motion-provider";
import { UnsavedChangesProvider } from "@/components/unsaved-changes-guard";
import { ClipboardFallback } from "@/components/clipboard-fallback";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s | ${APP_NAME}` },
  description:
    "A rich web interface for interacting with AI chatbots and agents",
  // Every page but sign-in sits behind auth: nothing here is worth indexing.
  robots: { index: false, follow: false },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: APP_NAME,
  },
  icons: {
    apple: withBasePath("/icon-192x192.png"),
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0d9488" },
    { media: "(prefers-color-scheme: dark)", color: "#0d9488" },
  ],
};

/**
 * The backend URL is a run-time setting, so it is read per request, behind
 * `connection()`, rather than baked into a prerendered page. Only this subtree
 * waits on the request; the document shell around it stays static.
 */
async function RuntimeAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  return (
    <AuthProvider backendUrl={getEnv().BACKEND_URL}>{children}</AuthProvider>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `console.log(${JSON.stringify(
              [
                "",
                "╔══════════════════════════════════════════════════════════╗",
                "║                                                          ║",
                "║   🦆 Well, well, well... a fellow source code explorer!  ║",
                "║                                                          ║",
                "║   You found the secret platypus den.                     ║",
                "║   Since you're clearly a person of refined taste,        ║",
                "║   come say hello on GitHub:                              ║",
                "║                                                          ║",
                "║   https://github.com/willdady/platypus                   ║",
                "║                                                          ║",
                "║   Stars, forks, and pull requests welcome! ⭐            ║",
                "║                                                          ║",
                "╚══════════════════════════════════════════════════════════╝",
                "",
              ].join("\n"),
            )});`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased h-dvh overflow-hidden`}
      >
        <SkipLink />
        <Suspense>
          <RuntimeAuthProvider>
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <MotionProvider>
                <UnsavedChangesProvider>
                  {children}
                  <Toaster position="top-right" />
                  <ClipboardFallback />
                </UnsavedChangesProvider>
              </MotionProvider>
            </ThemeProvider>
          </RuntimeAuthProvider>
        </Suspense>
      </body>
    </html>
  );
}
