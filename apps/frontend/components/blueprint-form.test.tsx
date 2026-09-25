import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  push,
  resetFormHarness,
  setDataFor,
  setLoading,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";
import { installResizeObserverStub, selectOption } from "@/lib/test-utils";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
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
    ).toBeNull();
    // A group whose list landed empty still says so.
    expect(
      screen.getByText("No shared skills in this organization yet."),
    ).toBeInTheDocument();
  });

  it("holds the form back until the providers land, so its selects aren't blank", () => {
    setLoading("/organizations/org1/providers");

    render(<BlueprintForm orgId="org1" />);

    expect(screen.getByLabelText("Loading blueprint")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

// ADR-0008: a Tier 2 slot may only point at a Provider the Blueprint attaches.
describe("BlueprintForm Tier 2 provider slots", () => {
  beforeEach(() => {
    resetFormHarness();
    installResizeObserverStub();
    setDataFor("/organizations/org1/providers", {
      results: [{ id: "p1", name: "OpenAI" }],
    });
    setDataFor("/organizations/org1/agents", {
      results: [{ id: "a1", name: "Helper" }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

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
    expect(savedBody(fetchMock)).toEqual({
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
    expect(savedBody(fetchMock)).toMatchObject({
      items: [],
      taskModelProviderId: null,
    });
  });
});
