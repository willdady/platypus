import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import { scrubDeletedAgentReference } from "./agent-references.ts";

describe("scrubDeletedAgentReference", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  it("updates agents to drop a deleted skill id from skillIds", async () => {
    await scrubDeletedAgentReference(mockDb as never, "skillIds", "skill-1");
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalled();
    expect(mockDb.where).toHaveBeenCalled();
  });

  it("updates agents to drop a deleted sub-agent id from subAgentIds", async () => {
    await scrubDeletedAgentReference(mockDb as never, "subAgentIds", "agent-9");
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalled();
  });

  it("updates agents to drop a deleted MCP id from toolSetIds", async () => {
    await scrubDeletedAgentReference(mockDb as never, "toolSetIds", "mcp-2");
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.set).toHaveBeenCalled();
  });
});
