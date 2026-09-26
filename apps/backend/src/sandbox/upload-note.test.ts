import { describe, expect, it } from "vitest";
import { convertToModelMessages } from "ai";
import { SANDBOX_TRANSFER_MAX_BYTES as SDK_BOUND } from "@platypuschat/plugin-sdk";
import { SANDBOX_TRANSFER_MAX_BYTES } from "@platypus/schemas";
import type { PlatypusUIMessage } from "../types.ts";
import { convertDataPart } from "./upload-note.ts";

describe("a Sandbox upload part reaching the model", () => {
  it("becomes a note of its path and size, never its bytes", async () => {
    const messages: PlatypusUIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          {
            type: "data-sandbox-upload",
            data: { path: "data.csv", filename: "data.csv", size: 1_200_000 },
          },
          { type: "text", text: "Summarise it" },
        ],
      },
    ];

    const converted = await convertToModelMessages(messages, {
      convertDataPart,
    });

    expect(converted).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "User uploaded `data.csv` (1.2 MB) to the Sandbox at `data.csv`",
          },
          { type: "text", text: "Summarise it" },
        ],
      },
    ]);
  });
});

// The frontend refuses an oversized file against the schemas copy of the
// bound; the backend enforces the SDK's. They must be the same number.
it("the schemas transfer bound matches the plugin SDK's", () => {
  expect(SANDBOX_TRANSFER_MAX_BYTES).toBe(SDK_BOUND);
});
