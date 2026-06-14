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

const title = "Platypus";
const description =
  "Platypus is a self-hosted, multi-tenant platform for building and managing AI agents — agents that reason, use tools, and connect to your data through the Model Context Protocol.";

export const metadata: Metadata = {
  metadataBase: new URL("https://platypus.chat"),
  title: {
    default: title,
    template: `%s | ${title}`,
  },
  description,
  applicationName: title,
  icons: {
    icon: "/favicon.ico",
    apple: "/icon-192x192.png",
  },
  openGraph: {
    type: "website",
    siteName: title,
    title,
    description,
    url: "/",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
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
        {children}
      </body>
    </html>
  );
};

export default RootLayout;
