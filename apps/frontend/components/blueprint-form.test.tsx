import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { blueprintCreateSchema } from "@platypus/schemas";
import { expectSentBodyToMatchSchema } from "@/test/test-utils";
import {
  authMock,
  swrMock,
  push,
  resetFormHarness,
  setDataFor,
  setError,
  setLoading,
  setupUser,
  stubAcceptedSave,
  stubRejectedSave,
} from "@/test/form-test-harness";
import { selectOption } from "@/test/test-utils";
import { scopedPath } from "@/lib/api-write";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { BlueprintForm } from "./blueprint-form";

describe("BlueprintForm shared resource groups", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/organizations/org1/providers", { results: [] });
  });

  it("doesn't claim a group is empty while its list is still loading", () => {
    setLoading("/organizations/org1/agents");

    render(<BlueprintForm orgId="org1" />);

    expect(
      screen.queryByText("No shared agents in this organization yet."),
    ).not.toBeInTheDocument();
    // A group whose list landed empty still says so.
    expect(
      screen.getByText("No shared skills in this organization yet."),
    ).toBeInTheDocument();
  });

  it("holds the form back until the providers land, so its selects aren't blank", () => {
    setLoading("/organizations/org1/providers");

    render(<BlueprintForm orgId="org1" />);

    expect(screen.getByLabelText("Loading blueprint")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});

describe("BlueprintForm form submission", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/organizations/org1/providers", { results: [] });
  });

  it("saves on Enter in the Name field", async () => {
    const fetchMock = stubAcceptedSave({ id: "b1" });
    render(<BlueprintForm orgId="org1" />);

    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Starter" } });
    await setupUser().type(name, "{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      expectSentBodyToMatchSchema(fetchMock, blueprintCreateSchema),
    ).toMatchObject({ name: "Starter" });
  });
});

describe("BlueprintForm shared resource read failures", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/organizations/org1/providers", { results: [] });
  });

  // A group's own read failing must not read as "this organization has none".
  it.each([
    ["agents", "agents", "No shared agents in this organization yet."],
    ["skills", "skills", "No shared skills in this organization yet."],
    ["mcps", "MCP servers", "No shared mcp servers in this organization yet."],
    ["providers", "providers", "No shared providers in this organization yet."],
  ])(
    "shows the %s read failure instead of claiming there are none",
    (collection, subject, noneText) => {
      const key = scopedPath(collection, { orgId: "org1" });
      setDataFor(key, undefined);
      setError(new Error("500"), key);

      render(<BlueprintForm orgId="org1" />);

      expect(
        screen.getByText(new RegExp(`Failed to load ${subject}`)),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.queryByText(noneText)).not.toBeInTheDocument();
    },
  );
});

// ADR-0008: a Tier 2 slot may only point at a Provider the Blueprint attaches.
describe("BlueprintForm Tier 2 provider slots", () => {
  beforeEach(() => {
    resetFormHarness();
    setDataFor("/organizations/org1/providers", {
      results: [{ id: "p1", name: "OpenAI" }],
    });
    setDataFor("/organizations/org1/agents", {
      results: [{ id: "a1", name: "Helper" }],
    });
  });

  const taskModelSelect = () =>
    screen.getByRole("combobox", { name: "Task model provider" });

  const attachProviderAndPickIt = async () => {
    render(<BlueprintForm orgId="org1" />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Starter" },
    });
    expect(taskModelSelect()).toBeDisabled();

    fireEvent.click(screen.getByRole("switch", { name: "OpenAI" }));
    await selectOption(taskModelSelect(), "OpenAI");
    // No model id for the slot: the name alone, never empty brackets.
    expect(taskModelSelect()).toHaveTextContent(/^OpenAI$/);
  };

  const save = () =>
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

  it("saves the attached items and the slot pointing at an attached Provider", async () => {
    const fetchMock = stubAcceptedSave({ id: "bp1" });
    await attachProviderAndPickIt();
    fireEvent.click(screen.getByRole("switch", { name: "Helper" }));
    save();

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/settings/blueprints"),
    );
    expect(
      expectSentBodyToMatchSchema(fetchMock, blueprintCreateSchema),
    ).toEqual({
      name: "Starter",
      items: [
        { resourceType: "provider", resourceId: "p1" },
        { resourceType: "agent", resourceId: "a1" },
      ],
      context: null,
      taskModelProviderId: "p1",
      memoryExtractionProviderId: null,
      memoryEmbeddingProviderId: null,
    });
  });

  it("clears a slot when its Provider is detached", async () => {
    const fetchMock = stubAcceptedSave({ id: "bp1" });
    await attachProviderAndPickIt();

    fireEvent.click(screen.getByRole("switch", { name: "OpenAI" }));
    expect(taskModelSelect()).toBeDisabled();
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      expectSentBodyToMatchSchema(fetchMock, blueprintCreateSchema),
    ).toMatchObject({
      items: [],
      taskModelProviderId: null,
    });
  });

  it("names an attached provider with the model its slot runs against, in the list and the trigger", async () => {
    setDataFor("/organizations/org1/providers", {
      results: [
        {
          id: "p1",
          name: "OpenAI",
          taskModelId: "gpt-4o-mini",
          memoryExtractionModelId: "gpt-4o",
        },
      ],
    });
    render(<BlueprintForm orgId="org1" />);
    fireEvent.click(screen.getByRole("switch", { name: "OpenAI" }));

    const extraction = screen.getByRole("combobox", {
      name: "Memory extraction provider",
    });
    await selectOption(extraction, "OpenAI (gpt-4o)");

    expect(extraction).toHaveTextContent("OpenAI (gpt-4o)");
  });

  it("retracts a rejected provider's error when the pointer changes", async () => {
    stubRejectedSave([
      { path: ["taskModelProviderId"], message: "Provider unavailable" },
    ]);
    render(<BlueprintForm orgId="org1" />);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Starter" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "OpenAI" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Provider unavailable")).toBeInTheDocument();

    await selectOption(taskModelSelect(), "OpenAI");

    expect(screen.queryByText("Provider unavailable")).not.toBeInTheDocument();
  });
});
