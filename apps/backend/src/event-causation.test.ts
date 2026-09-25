import { describe, it, expect } from "vitest";
import {
  currentCausingAgents,
  currentOriginatingTrigger,
  withAgentCausation,
  withCausation,
  withChildCausation,
  withOriginatingTrigger,
} from "./event-causation.ts";

describe("event-causation", () => {
  describe("currentCausingAgents", () => {
    it("reads an empty chain outside any Agent's work", () => {
      expect(currentCausingAgents()).toEqual([]);
    });

    it("reads the chain established for the current work, across awaits", async () => {
      const seen = await withCausation(["agent-1"], async () => {
        await Promise.resolve();
        return currentCausingAgents();
      });
      expect(seen).toEqual(["agent-1"]);
    });

    it("establishes a single Agent, or nothing when there is none", () => {
      expect(withAgentCausation("agent-1", currentCausingAgents)).toEqual([
        "agent-1",
      ]);
      expect(withAgentCausation(undefined, currentCausingAgents)).toEqual([]);
    });

    it("appends each delegate to its parent's chain", () => {
      const seen = withAgentCausation("agent-1", () =>
        withChildCausation("sub-1", () =>
          withChildCausation("sub-2", currentCausingAgents),
        ),
      );
      expect(seen).toEqual(["agent-1", "sub-1", "sub-2"]);
    });

    it("gives a delegate outside any parent a chain of its own", () => {
      expect(withChildCausation("sub-1", currentCausingAgents)).toEqual([
        "sub-1",
      ]);
    });
  });

  describe("currentOriginatingTrigger", () => {
    it("reads undefined outside any Trigger run", () => {
      expect(currentOriginatingTrigger()).toBeUndefined();
    });

    it("reads the Trigger whose run is driving the current work", () => {
      const seen = withOriginatingTrigger("trigger-1", () =>
        currentOriginatingTrigger(),
      );
      expect(seen).toBe("trigger-1");
    });

    it("establishes nothing when there is no Trigger", () => {
      const seen = withOriginatingTrigger(undefined, () =>
        currentOriginatingTrigger(),
      );
      expect(seen).toBeUndefined();
    });

    it("survives the async work the run does inside it", async () => {
      const seen = await withOriginatingTrigger("trigger-1", async () => {
        await Promise.resolve();
        return currentOriginatingTrigger();
      });
      expect(seen).toBe("trigger-1");
    });

    it("names the innermost Trigger when one Trigger's run fires another", () => {
      const seen = withOriginatingTrigger("trigger-1", () =>
        withOriginatingTrigger("trigger-2", () => currentOriginatingTrigger()),
      );
      expect(seen).toBe("trigger-2");
    });

    it("is independent of the Agent chain — each reads its own store", () => {
      const seen = withOriginatingTrigger("trigger-1", () =>
        withCausation(["agent-1"], () =>
          withChildCausation("sub-1", () => ({
            agents: currentCausingAgents(),
            trigger: currentOriginatingTrigger(),
          })),
        ),
      );
      expect(seen).toEqual({
        agents: ["agent-1", "sub-1"],
        trigger: "trigger-1",
      });
    });
  });
});
