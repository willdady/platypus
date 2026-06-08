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
      <Head />
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
