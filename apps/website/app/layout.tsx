import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { FC, ReactNode } from "react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const brand = "Platypus";
// ~54 chars: descriptive enough for search snippets while leading with the brand.
const title = "Platypus — Self-Hosted Platform for Building AI Agents";
// ~152 chars: trimmed to stay within Google's ~160-char snippet limit.
const description =
  "Platypus is a self-hosted, multi-tenant platform for building AI agents that reason, use tools, and connect to your data via the Model Context Protocol.";

export const metadata: Metadata = {
  metadataBase: new URL("https://platypus.chat"),
  title: {
    default: title,
    template: `%s | ${brand}`,
  },
  description,
  applicationName: brand,
  alternates: {
    canonical: "/",
  },
  icons: {
    // app/favicon.ico is auto-linked by Next's file convention; add the PNGs here.
    icon: [
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [{ url: "/icon-192x192.png", type: "image/png", sizes: "192x192" }],
  },
  openGraph: {
    type: "website",
    siteName: brand,
    title,
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
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

// JSON-LD structured data: describe both the site and the software it markets.
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://platypus.chat/#website",
      url: "https://platypus.chat",
      name: brand,
      description,
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://platypus.chat/#software",
      name: brand,
      description,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Linux, macOS, Windows",
      url: "https://platypus.chat",
      softwareHelp: "https://docs.platypus.chat",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
    },
  ],
};

export const viewport: Viewport = {
  themeColor: "#0d9488",
};

const RootLayout: FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <html lang="en" dir="ltr">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
};

export default RootLayout;
