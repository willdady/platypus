// @vitest-environment node
import { describe, it, expect } from "vitest";
import { CHAT_MAX_STEPS_MAX, CHAT_MAX_STEPS_MIN } from "@platypus/schemas";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import {
  CHAT_MAX_STEPS_ERROR,
  CHAT_SELECTION_ERROR,
  turnRequest,
} from "./chat-turn";

const settings: ChatSettings = {
  instructions: "Be brief.",
  temperature: 0.5,
  topP: 0.9,
  topK: 40,
  seed: 7,
  presencePenalty: 0.1,
  frequencyPenalty: 0.2,
  maxSteps: 10,
};

const direct = { agentId: "", providerId: "p1", modelId: "m1" };
const agent = { agentId: "a1", providerId: "", modelId: "" };

describe("turnRequest", () => {
  it("sends an Agent turn as the Agent and the search toggle alone", () => {
    expect(turnRequest({ selection: agent, settings, search: true })).toEqual({
      ok: true,
      body: { agentId: "a1", search: true },
    });
  });

  // The Agent supplies its own ceiling, so a value left invalid in the
  // Direct settings dialog is no reason to refuse it.
  it("ignores an invalid Max steps on an Agent turn", () => {
    expect(
      turnRequest({
        selection: agent,
        settings: { ...settings, maxSteps: CHAT_MAX_STEPS_MAX + 1 },
        search: false,
      }),
    ).toEqual({ ok: true, body: { agentId: "a1", search: false } });
  });

  it("sends a Direct turn with the Provider, model and every setting", () => {
    expect(turnRequest({ selection: direct, settings, search: false })).toEqual(
      {
        ok: true,
        body: {
          providerId: "p1",
          modelId: "m1",
          instructions: "Be brief.",
          temperature: 0.5,
          topP: 0.9,
          topK: 40,
          seed: 7,
          presencePenalty: 0.1,
          frequencyPenalty: 0.2,
          maxSteps: 10,
          search: false,
        },
      },
    );
  });

  it("leaves empty instructions off a Direct turn", () => {
    const request = turnRequest({
      selection: direct,
      settings: { ...settings, instructions: "" },
      search: false,
    });

    expect(request.ok && request.body.instructions).toBeUndefined();
  });

  it.each([
    { providerId: "", modelId: "" },
    { providerId: "p1", modelId: "" },
    { providerId: "", modelId: "m1" },
  ])("refuses with no Agent and an incomplete model (%o)", (partial) => {
    expect(
      turnRequest({
        selection: { agentId: "", ...partial },
        settings,
        search: false,
      }),
    ).toEqual({ ok: false, reason: CHAT_SELECTION_ERROR });
  });

  it.each([CHAT_MAX_STEPS_MIN - 1, CHAT_MAX_STEPS_MAX + 1, 1.5])(
    "refuses a Direct turn with Max steps %s",
    (maxSteps) => {
      expect(
        turnRequest({
          selection: direct,
          settings: { ...settings, maxSteps },
          search: false,
        }),
      ).toEqual({ ok: false, reason: CHAT_MAX_STEPS_ERROR });
    },
  );

  it.each([undefined, null, CHAT_MAX_STEPS_MIN, CHAT_MAX_STEPS_MAX])(
    "accepts a Direct turn with Max steps %s",
    (maxSteps) => {
      expect(
        turnRequest({
          selection: direct,
          settings: { ...settings, maxSteps: maxSteps as number | undefined },
          search: false,
        }).ok,
      ).toBe(true);
    },
  );
});
