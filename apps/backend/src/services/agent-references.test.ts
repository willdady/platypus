import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { agent as agentTable } from "../db/schema.ts";
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
      await scrubDeletedAgentReference(mockDb as never, field, id);

      expect(mockDb.update).toHaveBeenCalledWith(agentTable);
      const patch = mockDb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual([field, "updatedAt"].sort());
      // `<column> - <id>` drops the element from the jsonb array.
      expect(patch[field]).toMatchObject({
        op: "sql",
        values: [agentTable[field], id],
      });
      // `<column> @> '["<id>"]'` limits the write to rows that hold the id.
      expect(mockDb.where).toHaveBeenCalledWith(
        expect.objectContaining({
          op: "sql",
          values: [agentTable[field], JSON.stringify([id])],
        }),
      );
    },
  );
});
