import { describe, it, expect } from "vitest";
import { agentCreateSchema } from "@platypus/schemas";
import { expectSentBodyToMatchSchema } from "./test-utils";

/** A fetch stub carrying one JSON request body, as the helper reads it. */
function fetchMockWith(body: unknown) {
  return {
    mock: {
      calls: [
        [
          "http://test/organizations/org1/agents",
          { body: JSON.stringify(body) },
        ],
      ],
    },
  };
}

const validAgent = {
  name: "Bot",
  description: "A test Agent",
  providerId: "p1",
  modelId: "gpt-4o",
};

describe("expectSentBodyToMatchSchema", () => {
  it("passes a body the shared request schema accepts", () => {
    expect(
      expectSentBodyToMatchSchema(fetchMockWith(validAgent), agentCreateSchema),
    ).toMatchObject(validAgent);
  });

  it("fails with the Zod issue for a key the strict schema refuses", () => {
    expect(() =>
      expectSentBodyToMatchSchema(
        fetchMockWith({ ...validAgent, workspaceId: "ws1" }),
        agentCreateSchema,
      ),
    ).toThrow(/Unrecognized key: "workspaceId"/);
  });
});
