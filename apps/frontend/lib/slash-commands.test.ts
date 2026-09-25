// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  completeSlashCommand,
  rankSlashCommands,
  skillsForAgent,
  slashQueryOf,
  type SlashCommand,
} from "./slash-commands";

const command = (name: string): SlashCommand => ({
  name,
  description: `Does ${name}`,
});

describe("slashQueryOf", () => {
  it("reads the partial name of a command being typed", () => {
    expect(slashQueryOf("/")).toBe("");
    expect(slashQueryOf("/blog")).toBe("blog");
  });

  it("refuses a slash anywhere but position 0", () => {
    expect(slashQueryOf("tell me about /blog")).toBe(null);
    expect(slashQueryOf(" /blog")).toBe(null);
  });

  it("ends the command at the first space, where the prompt begins", () => {
    expect(slashQueryOf("/blog-post ")).toBe(null);
    expect(slashQueryOf("/blog-post about otters")).toBe(null);
  });

  it("refuses an empty value", () => {
    expect(slashQueryOf("")).toBe(null);
  });
});

describe("rankSlashCommands", () => {
  const commands = [
    command("deploy-staging"),
    command("blog-post"),
    command("deploy"),
  ];

  it("offers everything for a bare slash, alphabetically", () => {
    expect(rankSlashCommands(commands, "").map((c) => c.name)).toEqual([
      "blog-post",
      "deploy",
      "deploy-staging",
    ]);
  });

  // A prefix collision: both stay candidates, but the name the user has fully
  // typed leads, so Tab accepts what is visibly highlighted.
  it("puts an exact match ahead of a longer name sharing its prefix", () => {
    expect(rankSlashCommands(commands, "deploy").map((c) => c.name)).toEqual([
      "deploy",
      "deploy-staging",
    ]);
  });

  it("ranks a prefix match ahead of a mid-name one", () => {
    const withMid = [command("run-deploy"), command("deploy-staging")];
    expect(rankSlashCommands(withMid, "deploy").map((c) => c.name)).toEqual([
      "deploy-staging",
      "run-deploy",
    ]);
  });

  it("ignores case", () => {
    expect(rankSlashCommands(commands, "BLOG").map((c) => c.name)).toEqual([
      "blog-post",
    ]);
  });

  it("returns nothing for a name no Skill carries", () => {
    expect(rankSlashCommands(commands, "usr")).toEqual([]);
  });
});

describe("completeSlashCommand", () => {
  it("leaves a trailing space, which both closes the picker and starts the prompt", () => {
    expect(completeSlashCommand("blog-post")).toBe("/blog-post ");
  });
});

describe("skillsForAgent", () => {
  const skills = [
    { id: "s1", name: "blog-post" },
    { id: "s2", name: "deploy" },
    { id: "s3", name: "audit" },
  ];

  it("narrows the Workspace's Skills to the Agent's, in assignment order", () => {
    expect(skillsForAgent(skills, ["s3", "s1"])).toEqual([
      { id: "s3", name: "audit" },
      { id: "s1", name: "blog-post" },
    ]);
  });

  it("drops an id no Skill answers to, rather than leaving a hole", () => {
    expect(skillsForAgent(skills, ["s1", "gone"])).toEqual([
      { id: "s1", name: "blog-post" },
    ]);
  });

  it("offers nothing for an Agent with no assignment", () => {
    expect(skillsForAgent(skills, undefined)).toEqual([]);
    expect(skillsForAgent(skills, [])).toEqual([]);
  });
});
