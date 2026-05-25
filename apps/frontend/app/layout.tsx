import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import ClientProvider from "./client-context";
import { AuthProvider } from "@/components/auth-provider";
import { headers } from "next/headers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Platypus",
  description:
    "A rich web interface for interacting with AI chatbots and agents",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Platypus",
  },
  icons: {
    apple: "/icon-192x192.png",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#0d9488" },
    { media: "(prefers-color-scheme: dark)", color: "#0d9488" },
  ],
};

// Force dynamic rendering to ensure environment variables are read at runtime
// and not baked into the static output during build time.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let backendUrl = process.env.BACKEND_URL || "";
  // When BACKEND_PORT is set (without a fixed BACKEND_URL), derive the backend
  // origin from the browser's actual Host header so the app works on any
  // network — LAN, SSH tunnel, etc.
  if (!backendUrl && process.env.BACKEND_PORT) {
    const hdrs = await headers();
    const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "";
    const hostname = host.split(":")[0];
    backendUrl = `http://${hostname}:${process.env.BACKEND_PORT}`;
  }

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
        <AuthProvider backendUrl={backendUrl}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <ClientProvider backendUrl={backendUrl}>{children}</ClientProvider>
            <Toaster position="top-right" />
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
