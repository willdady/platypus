import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "session=1" }),
}));

vi.mock("@/components/protected-route", () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/settings-shell", () => ({
  SettingsShell: ({
    headerLeft,
    children,
  }: {
    headerLeft?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <header>{headerLeft}</header>
      <main>{children}</main>
    </div>
  ),
}));

vi.mock("@/components/back-button", () => ({
  BackButton: ({
    variant,
    fallbackHref,
  }: {
    variant?: string;
    fallbackHref?: string;
  }) => (
    <button
      aria-label="Back"
      data-variant={variant}
      data-fallback-href={fallbackHref}
    />
  ),
}));

import OrgSettingsLayout, { generateMetadata } from "./layout";

function metadataFor() {
  return generateMetadata({ params: Promise.resolve({ orgId: "org1" }) });
}

async function renderLayout() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "org1", name: "Acme" }), {
          status: 200,
        }),
    ),
  );

  const layout = await OrgSettingsLayout({
    children: <p>page</p>,
    params: Promise.resolve({ orgId: "org1" }),
  });
  return render(layout);
}

describe("OrgSettingsLayout metadata", () => {
  it("names the Organization in the title of every settings page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "org1", name: "Acme" }), {
            status: 200,
          }),
      ),
    );

    await expect(metadataFor()).resolves.toMatchObject({
      title: { default: "Acme", template: "%s | Acme | Platypus" },
    });
  });

  it("leaves the title to the app when the Organization cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const metadata = await metadataFor();
    expect(metadata.title).toBeUndefined();
  });
});

describe("OrgSettingsLayout header", () => {
  it("gives the header Back the settings root as its fallback", async () => {
    await renderLayout();

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toHaveAttribute("data-variant", "header");
    expect(back).toHaveAttribute("data-fallback-href", "/org1/settings");
  });
});
