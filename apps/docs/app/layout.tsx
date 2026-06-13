import type { Metadata } from "next";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import type { FC, ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Platypus Docs",
    template: "%s | Platypus Docs",
  },
  description:
    "Documentation for Platypus — build and manage AI agents with tool support and multi-provider capabilities.",
  applicationName: "Platypus Docs",
};

const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

const navbar = (
  <Navbar
    logo={<b>Platypus</b>}
    projectLink="https://github.com/willdady/platypus"
  />
);

const footer = (
  <Footer className="flex-col items-center md:items-start">
    <p className="text-xs">Platypus Docs · v{version} · © 2026 Platypus</p>
  </Footer>
);

const RootLayout: FC<{ children: ReactNode }> = async ({ children }) => {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      {/*
       * Brand cohesion with apps/frontend (ADR-0011): Nextra's <Head> injects an
       * inline <style> that drives the accent from these HSL values, overriding
       * any CSS. The frontend's green `--primary` (oklch 0.488 0.243 180) is
       * hsl(166 100% 26%) — express it here so links/nav/rings render green, not
       * Nextra's default blue (hue 212/204). Lightness is bumped in dark mode for
       * legibility.
       */}
      <Head
        color={{
          hue: 166,
          saturation: 100,
          lightness: { light: 30, dark: 45 },
        }}
      >
        {/*
         * Anti-FOUC: Nextra renders its next-themes script inside <body>, so the
         * page can paint one light frame before the theme class lands on <html>.
         * Mirror next-themes here in <head> (same `theme` storage key, same
         * `system` default) to set the class before first paint. Idempotent with
         * Nextra's later script.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme'),d=t==='dark'||((!t||t==='system')&&matchMedia('(prefers-color-scheme: dark)').matches),e=document.documentElement;e.classList.toggle('dark',d);e.style.colorScheme=d?'dark':'light'}catch(e){}",
          }}
        />
      </Head>
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          // Nextra appends `/content/<page>` — edits land in apps/docs/content.
          docsRepositoryBase="https://github.com/willdady/platypus/tree/main/apps/docs"
          editLink="Edit this page on GitHub"
          sidebar={{ defaultMenuCollapseLevel: 1 }}
          footer={footer}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
};

export default RootLayout;
