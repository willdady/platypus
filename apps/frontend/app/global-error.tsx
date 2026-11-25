"use client";

import "./globals.css";
import { RouteError, type ErrorBoundaryProps } from "@/components/route-error";

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
