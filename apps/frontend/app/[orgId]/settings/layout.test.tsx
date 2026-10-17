import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "session=1" }),
}));

import { generateMetadata } from "./layout";

function metadataFor() {
  return generateMetadata({ params: Promise.resolve({ orgId: "org1" }) });
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
