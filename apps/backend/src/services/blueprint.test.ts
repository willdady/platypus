import { describe, it, expect, beforeEach } from "vitest";
import { resetMockDb, seedDb, type FakeDb } from "../test-utils.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import {
  createBlueprint,
  getBlueprint,
  requireBlueprint,
  updateBlueprint,
} from "./blueprint.ts";

const orgId = "org-1";

const fields = (overrides = {}) => ({
  name: "Starter kit",
  items: [{ resourceType: "agent" as const, resourceId: "shared-agent" }],
  ...overrides,
});

describe("Blueprint service", () => {
  let fake: FakeDb;

  beforeEach(() => {
    resetMockDb();
    fake = seedDb({
      agent: [
        { id: "shared-agent", organizationId: orgId, workspaceId: null },
        { id: "ws-agent", organizationId: null, workspaceId: "ws-1" },
      ],
      provider: [
        { id: "shared-provider", organizationId: orgId, workspaceId: null },
      ],
      blueprint: [{ id: "bp-other", organizationId: "org-2", name: "Other" }],
      blueprint_item: [],
    });
  });

  it("dedupes duplicate items", async () => {
    const created = await createBlueprint(
      orgId,
      fields({
        items: [
          { resourceType: "agent", resourceId: "shared-agent" },
          { resourceType: "agent", resourceId: "shared-agent" },
        ],
      }),
    );
    expect(created.items).toEqual([
      { resourceType: "agent", resourceId: "shared-agent" },
    ]);
    expect(fake.tables.blueprint_item).toHaveLength(1);
  });

  it("rejects an item that is not a Shared resource", async () => {
    await expect(
      createBlueprint(
        orgId,
        fields({ items: [{ resourceType: "agent", resourceId: "ws-agent" }] }),
      ),
    ).rejects.toThrow(
      new NotFoundError(
        "Shared resources not found in this organization: agent ws-agent",
      ),
    );
    expect(fake.tables.blueprint).toHaveLength(1);
  });

  it("rejects a Tier 2 Provider the blueprint does not attach", async () => {
    await expect(
      createBlueprint(
        orgId,
        fields({ taskModelProviderId: "shared-provider" }),
      ),
    ).rejects.toThrow(
      new ValidationError(
        "A blueprint's provider settings must reference providers the blueprint also attaches: shared-provider",
      ),
    );
    expect(fake.tables.blueprint).toHaveLength(1);
  });

  it("accepts a Tier 2 Provider the blueprint attaches", async () => {
    const created = await createBlueprint(
      orgId,
      fields({
        items: [{ resourceType: "provider", resourceId: "shared-provider" }],
        taskModelProviderId: "shared-provider",
      }),
    );
    expect(created.taskModelProviderId).toBe("shared-provider");
  });

  it("throws NotFoundError when the blueprint is deleted right after it is written", async () => {
    let written = false;
    fake = seedDb(structuredClone(fake.tables), {
      onQuery: (query) => {
        if (query.table !== "blueprint") return;
        if (query.kind === "insert") written = true;
        else if (written && query.kind === "select") {
          fake.tables.blueprint = fake.tables.blueprint.filter(
            (row) => row.organizationId !== orgId,
          );
        }
      },
    });

    await expect(createBlueprint(orgId, fields())).rejects.toThrow(
      new NotFoundError("Blueprint not found"),
    );
  });

  it("throws NotFoundError for a blueprint in another organization", async () => {
    await expect(requireBlueprint("bp-other", orgId)).rejects.toThrow(
      new NotFoundError("Blueprint not found"),
    );
    await expect(getBlueprint("bp-other", orgId)).rejects.toThrow(
      NotFoundError,
    );
    await expect(updateBlueprint("bp-other", orgId, fields())).rejects.toThrow(
      NotFoundError,
    );
  });
});
