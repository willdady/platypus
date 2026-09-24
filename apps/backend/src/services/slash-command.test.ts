import { describe, expect, it, vi } from "vitest";

import {
  SLASH_COMMAND_PATTERN,
  seedUserInvokedSkill,
  slashCommandOf,
  type SlashCommandQueries,
} from "./slash-command.ts";
import type { PlatypusUIMessage } from "../types.ts";

const userMessage = (text: string): PlatypusUIMessage => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text }],
});

const queriesFor = (
  skills: Array<{ id: string; name: string; body: string }>,
  skillIds: string[] | null = skills.map((s) => s.id),
) => {
  const getAgentSkillIds = vi
    .fn<SlashCommandQueries["getAgentSkillIds"]>()
    .mockResolvedValue(skillIds);
  const resolveAssignedSkill = vi
    .fn<SlashCommandQueries["resolveAssignedSkill"]>()
    .mockImplementation((name, _ctx, permitted) => {
      const found = skills.find(
        (s) => s.name === name && permitted.includes(s.id),
      );
      return Promise.resolve(
        found ? { name: found.name, body: found.body } : null,
      );
    });
  return { getAgentSkillIds, resolveAssignedSkill };
};

type FakeQueries = ReturnType<typeof queriesFor>;

const blogPost = {
  id: "s1",
  name: "blog-post",
  body: "Write a blog post.",
};

const seed = (messages: PlatypusUIMessage[], queries: FakeQueries) =>
  seedUserInvokedSkill(
    { messages, orgId: "org-1", workspaceId: "ws-1", agentId: "agent-1" },
    queries,
  );

describe("slashCommandOf", () => {
  it("reads a command at position 0", () => {
    expect(slashCommandOf([userMessage("/blog-post about otters")])).toBe(
      "blog-post",
    );
  });

  it("reads a command that is the whole message", () => {
    expect(slashCommandOf([userMessage("/blog-post")])).toBe("blog-post");
  });

  it("ignores a slash anywhere but position 0", () => {
    expect(slashCommandOf([userMessage("tell me about /blog-post")])).toBe(
      null,
    );
    expect(slashCommandOf([userMessage(" /blog-post")])).toBe(null);
  });

  it("parses greedily, so a longer name never resolves as a shorter one", () => {
    expect(slashCommandOf([userMessage("/deploy-staging now")])).toBe(
      "deploy-staging",
    );
  });

  it("reads the FIRST text part, past any attachments", () => {
    const withFile: PlatypusUIMessage = {
      id: "u1",
      role: "user",
      parts: [
        { type: "file", mediaType: "image/png", url: "storage://a.png" },
        { type: "text", text: "/blog-post" },
      ],
    };
    expect(slashCommandOf([withFile])).toBe("blog-post");
  });

  it("ignores a message that is not the latest, and a trailing assistant turn", () => {
    expect(
      slashCommandOf([
        userMessage("/blog-post"),
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "hi" }] },
      ]),
    ).toBe(null);
  });

  it("returns null for an empty transcript", () => {
    expect(slashCommandOf([])).toBe(null);
  });

  it("rejects a name that is not kebab-case", () => {
    expect(SLASH_COMMAND_PATTERN.exec("/Blog_Post")).toBe(null);
  });

  // The pattern is built from the shape `@platypus/schemas` enforces on save,
  // so a name it accepts is a name a Skill can have — a stray hyphen resolves
  // to the valid name beside it rather than to something unsaveable.
  it("accepts only a name a Skill could actually carry", () => {
    expect(slashCommandOf([userMessage("/-nope")])).toBe(null);
    expect(slashCommandOf([userMessage("/blog-post-")])).toBe("blog-post");
  });
});

describe("seedUserInvokedSkill", () => {
  it("appends the loadSkill pair as a trailing assistant message", async () => {
    const messages = [userMessage("/blog-post about otters")];
    const seeded = await seed(messages, queriesFor([blogPost]));

    expect(seeded).toHaveLength(2);
    // The user's own message is untouched: the token stays in the text, which
    // is what the transcript renders and what a later edit round-trips.
    expect(seeded[0]).toBe(messages[0]);

    const trailing: PlatypusUIMessage = seeded[1];
    expect(trailing.role).toBe("assistant");
    expect(trailing.parts).toHaveLength(1);

    const part = trailing.parts[0];
    if (part.type !== "tool-loadSkill") {
      throw new Error(`expected a loadSkill part, got ${part.type}`);
    }
    expect(part.state).toBe("output-available");
    expect(part.toolCallId).toMatch(/^call/);
    expect(part.input).toEqual({ name: "blog-post" });
    expect(part.output).toEqual({
      name: "blog-post",
      body: "Write a blog post.",
    });
  });

  it("seeds a command-only message, which sends as a non-empty text part", async () => {
    const seeded = await seed(
      [userMessage("/blog-post")],
      queriesFor([blogPost]),
    );
    expect(seeded).toHaveLength(2);
    expect(seeded[0].parts).toEqual([{ type: "text", text: "/blog-post" }]);
  });

  it("leaves an unknown command as plain text", async () => {
    const messages = [userMessage("/usr/bin/env is broken")];
    expect(await seed(messages, queriesFor([blogPost]))).toBe(messages);
  });

  it("leaves a Skill assigned to some other Agent as plain text", async () => {
    const messages = [userMessage("/blog-post")];
    const queries = queriesFor([blogPost], ["s-other"]);
    expect(await seed(messages, queries)).toBe(messages);
  });

  it("leaves a message alone when the Agent has no Skills", async () => {
    const messages = [userMessage("/blog-post")];
    const queries = queriesFor([blogPost], []);
    expect(await seed(messages, queries)).toBe(messages);
    expect(queries.resolveAssignedSkill.mock.calls).toEqual([]);
  });

  it("leaves a message alone when the Agent does not resolve here", async () => {
    const messages = [userMessage("/blog-post")];
    expect(await seed(messages, queriesFor([blogPost], null))).toBe(messages);
  });

  it("does nothing on a Direct turn, which advertises no Skills", async () => {
    const messages = [userMessage("/blog-post")];
    const queries = queriesFor([blogPost]);
    expect(
      await seedUserInvokedSkill(
        { messages, orgId: "org-1", workspaceId: "ws-1" },
        queries,
      ),
    ).toBe(messages);
    expect(queries.getAgentSkillIds.mock.calls).toEqual([]);
  });

  it("seeds only for the latest turn, leaving an earlier turn's pair in place", async () => {
    const earlier: PlatypusUIMessage[] = [
      userMessage("/blog-post about otters"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-loadSkill",
            toolCallId: "call-1",
            state: "output-available",
            input: { name: "blog-post" },
            output: { name: "blog-post", body: "Write a blog post." },
          },
          { type: "text", text: "Here you go." },
        ],
      },
    ];
    const followUp: PlatypusUIMessage = {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "make it shorter" }],
    };

    const seeded = await seed([...earlier, followUp], queriesFor([blogPost]));

    // Nothing new is seeded, and the persisted pair from the earlier turn still
    // carries its Skill body — the replayed conversation is the conversation
    // that happened.
    expect(seeded).toHaveLength(3);
    expect(seeded[1]).toBe(earlier[1]);
  });

  it("re-seeds when the same command is sent again (a regenerate)", async () => {
    const queries = queriesFor([blogPost]);
    const first = await seed([userMessage("/blog-post")], queries);
    const second = await seed([userMessage("/blog-post")], queries);

    // Distinct message ids, so a re-run never collides with the persisted pair
    // it is replacing.
    expect(first.at(-1)!.id).not.toBe(second.at(-1)!.id);
  });
});
