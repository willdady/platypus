import type { Metadata } from "next";
import Image from "next/image";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import type { FC, ReactNode } from "react";
import "./globals.css";

const title = "Platypus Docs";
const description =
  "Documentation for Platypus — build and manage AI agents with tool support and multi-provider capabilities.";

// Shared OG/Twitter bases. Exported so per-page `generateMetadata`
// (app/[[...mdxPath]]/page.tsx) can spread them when mirroring the page title:
// Next.js OVERWRITES (does not deep-merge) openGraph/twitter across segments, so
// a page that returns its own openGraph without these would drop `images` and
// the Twitter `card`, and no og:image tag would render.
export const openGraph: Metadata["openGraph"] = {
  type: "website",
  siteName: title,
  title: {
    default: title,
    template: `%s | ${title}`,
  },
  description,
  url: "/",
  locale: "en_US",
  images: [
    {
      url: "/og.png",
      width: 1200,
      height: 630,
      alt: "Platypus — build and manage AI agents with tool support and multi-provider capabilities.",
    },
  ],
};

export const twitter: Metadata["twitter"] = {
  card: "summary_large_image",
  title: {
    default: title,
    template: `%s | ${title}`,
  },
  description,
  images: ["/og.png"],
};

export const metadata: Metadata = {
  metadataBase: new URL("https://docs.platypus.chat"),
  title: {
    default: title,
    template: `%s | ${title}`,
  },
  description,
  applicationName: title,
  // Site-wide icons: page-level generateMetadata doesn't set `icons`, so these
  // are inherited by every doc page. app/favicon.ico is auto-linked by Next.
  icons: {
    icon: [
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" },
    ],
  },
  openGraph,
  twitter,
};

// JSON-LD structured data for the docs site, injected once in the root layout.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": "https://docs.platypus.chat/#website",
  url: "https://docs.platypus.chat",
  name: title,
  description,
  publisher: {
    "@type": "Organization",
    name: "Platypus",
    url: "https://platypus.chat",
  },
};

const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

const navbar = (
  <Navbar
    // Mirror the website's top-bar lockup (apps/website site-nav.tsx): the
    // platypus mark left of a bold wordmark, gap-2.
    logo={
      <span className="flex items-center gap-2 font-bold tracking-tight">
        <Image
          src="/platypus.png"
          alt="Platypus logo"
          width={40}
          height={40}
          priority
          className="size-10"
        />
        <span className="text-lg">Platypus</span>
      </span>
    }
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
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
