"use client";

import "./globals.css";
import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

/**
 * The last boundary: what renders when the root layout itself throws (the
 * auth provider included), in place of Next's bare default page. It replaces
 * the root layout, so it brings its own `<html>` and `<body>`.
 */
export default function GlobalError({ error, retry }: ErrorBoundaryProps) {
  return (
    <html lang="en">
      <body className="antialiased">
        <main>
          <RouteError error={error} retry={retry} source="root" />
        </main>
      </body>
    </html>
  );
}
