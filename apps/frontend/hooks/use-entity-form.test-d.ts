import { describe, it } from "vitest";
import { useEntityForm } from "./use-entity-form";

type Data = { name: string; description: string };

describe("useEntityForm options", () => {
  it("rejects a form that names neither an entity nor a write", () => {
    // @ts-expect-error a form writes through an entity or its own write
    useEntityForm<Data, unknown>({
      initialData: { name: "", description: "" },
    });
  });

  it("rejects a form that names an entity and brings its own write", () => {
    useEntityForm<Data, unknown>({
      initialData: { name: "", description: "" },
      entity: "skills",
      scope: { orgId: "org1" },
      // @ts-expect-error the entity is the write's target, or the form owns it
      write: () =>
        Promise.resolve({
          outcome: "success",
          data: undefined,
          revalidateKeys: [],
        }),
    });
  });

  it("checks buildPayload against the entity's request schema", () => {
    // @ts-expect-error a Skill has no `nonsense` field; the strict request schema would refuse it with a 400.
    useEntityForm<Data, unknown>({
      initialData: { name: "", description: "" },
      entity: "skills",
      scope: { orgId: "org1" },
      buildPayload: (data) => ({
        name: data.name,
        nonsense: data.description,
      }),
    });
  });
});
