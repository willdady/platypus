import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetMockDb, seedDb } from "../test-utils.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";

describe("scrubDeletedAgentReference", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  it.each([
    ["skillIds", "skill-1"],
    ["subAgentIds", "agent-9"],
    ["toolSetIds", "mcp-2"],
  ] as const)(
    "removes the id from %s on only the agents holding it",
    async (field, id) => {
      const fake = seedDb({
        agent: [
          { id: "holds", [field]: ["kept", id], updatedAt: "untouched" },
          { id: "lacks", [field]: ["kept"], updatedAt: "untouched" },
        ],
      });

      await scrubDeletedAgentReference(fake.handle as never, field, id);

      const [holds, lacks] = fake.tables.agent;
      expect(holds[field]).toEqual(["kept"]);
      expect(holds.updatedAt).toBeInstanceOf(Date);
      expect(lacks).toEqual({
        id: "lacks",
        [field]: ["kept"],
        updatedAt: "untouched",
      });
    },
  );
});
