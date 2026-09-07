import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";

// The Agent form itself is exercised in components/agent-form.test.tsx. Here it
// stands in as a prop recorder so these tests stay about what the *pages* hand
// it after reading the tool sets.
const { formProps } = vi.hoisted(() => ({
  formProps: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/components/agent-form", () => ({
  AgentForm: (props: Record<string, unknown>) => {
    formProps.current = props;
    return null;
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=abc" }),
}));

// The page shell renders a back button, which needs a router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

import AgentCreatePage from "./[orgId]/workspace/[workspaceId]/agents/create/page";
import AgentEditPage from "./[orgId]/workspace/[workspaceId]/agents/[agentId]/page";
import OrgAgentEditPage from "./[orgId]/settings/agents/[agentId]/page";

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

/** Runs a page the way Next does: resolve it, then render what it returned. */
async function renderPage(page: (typeof pages)[number]) {
  const element = await page.render();
  render(element);
  return element;
}

// Each page under test, with the params it takes.
const pages = [
  {
    name: "workspace Agent create",
    render: () =>
      AgentCreatePage({
        params: Promise.resolve({ orgId: "org1", workspaceId: "ws1" }),
      }),
  },
  {
    name: "workspace Agent edit",
    render: () =>
      AgentEditPage({
        params: Promise.resolve({
          orgId: "org1",
          workspaceId: "ws1",
          agentId: "a1",
        }),
      }),
  },
  {
    name: "org-scoped Shared Agent edit",
    render: () =>
      OrgAgentEditPage({
        params: Promise.resolve({ orgId: "org1", agentId: "a1" }),
      }),
  },
];

describe("Agent pages tool set loading", () => {
  beforeEach(() => {
    process.env.INTERNAL_BACKEND_URL = "http://backend:4000";
    formProps.current = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INTERNAL_BACKEND_URL;
  });

  for (const page of pages) {
    describe(page.name, () => {
      it("renders instead of throwing when the tool sets request is rejected as unauthorized", async () => {
        stubFetch({ error: "Unauthorized" }, 401);

        await expect(renderPage(page)).resolves.toBeTruthy();

        expect(formProps.current).toMatchObject({
          toolSets: [],
          toolSetsError: "unauthorized",
        });
      });

      it("renders instead of throwing when the backend is unreachable", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new Error("ECONNREFUSED");
          }),
        );

        await expect(renderPage(page)).resolves.toBeTruthy();

        expect(formProps.current).toMatchObject({
          toolSets: [],
          toolSetsError: "unavailable",
        });
      });

      it("passes the tool sets through with no error when the request succeeds", async () => {
        stubFetch({ results: [{ id: "ts1", name: "Web" }] });

        await expect(renderPage(page)).resolves.toBeTruthy();

        expect(formProps.current).toMatchObject({
          toolSets: [{ id: "ts1", name: "Web" }],
          toolSetsError: undefined,
        });
      });

      it("reports an empty catalogue as success, not as a failure", async () => {
        stubFetch({ results: [] });

        await renderPage(page);

        expect(formProps.current).toMatchObject({
          toolSets: [],
          toolSetsError: undefined,
        });
      });
    });
  }

  it("reads the org tool sets for a Shared Agent and the workspace tool sets otherwise", async () => {
    stubFetch({ results: [] });
    await OrgAgentEditPage({
      params: Promise.resolve({ orgId: "org1", agentId: "a1" }),
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://backend:4000/organizations/org1/tools",
      expect.anything(),
    );

    stubFetch({ results: [] });
    await AgentCreatePage({
      params: Promise.resolve({ orgId: "org1", workspaceId: "ws1" }),
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://backend:4000/organizations/org1/workspaces/ws1/tools",
      expect.anything(),
    );
  });
});
