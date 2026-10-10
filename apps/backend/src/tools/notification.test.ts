import { describe, it, expect, vi, beforeEach } from "vitest";
import { callTool, resetMockDb, seedDb, type FakeDb } from "../test-utils.ts";

vi.mock("../services/event-dispatch.ts", () => ({
  dispatchEvent: vi.fn(),
}));

import { createNotificationTools } from "./notification.ts";
import { dispatchEvent } from "../services/event-dispatch.ts";
import { withChildCausation, withRunSource } from "../event-causation.ts";

const workspaceId = "ws-1";
const agentId = "agent-1";
const orgId = "org-1";

const notification = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  workspaceId,
  agentId,
  title: null,
  body: id,
  createdAt: new Date("2026-01-01"),
  ...over,
});

describe("createNotificationTools", () => {
  let tools: ReturnType<typeof createNotificationTools>;
  let db: FakeDb;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    db = seedDb({
      notification: [
        notification("mine-old"),
        notification("mine-new", { createdAt: new Date("2026-02-01") }),
        notification("other-agent", { agentId: "agent-2" }),
        notification("other-workspace", { workspaceId: "ws-2" }),
      ],
    });
    tools = createNotificationTools(workspaceId, agentId, orgId);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "createNotification",
      "listNotifications",
      "updateNotification",
      "deleteNotification",
    ]);
  });

  it("createNotification stores it for this agent and workspace, unescaping newlines, and dispatches", async () => {
    const result: unknown = await callTool(tools.createNotification, {
      title: "Test",
      body: "line 1\\nline 2",
    });

    expect(result).toMatchObject({
      workspaceId,
      agentId,
      title: "Test",
      body: "line 1\nline 2",
    });
    expect(db.tables.notification).toContainEqual(
      expect.objectContaining({ title: "Test", body: "line 1\nline 2" }),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(orgId, workspaceId, {
      event: "notification.created",
      data: result,
    });
  });

  it("createNotification outside a run records no source", async () => {
    expect(
      await callTool(tools.createNotification, { body: "hi" }),
    ).toMatchObject({ source: null });
  });

  it.each([
    { kind: "chat", chatId: "chat-1" },
    { kind: "triggerRun", triggerRunId: "run-1" },
  ] as const)(
    "createNotification records the ambient $kind, from a Sub-Agent too",
    async (source) => {
      const result: unknown = await withRunSource(source, () =>
        withChildCausation("sub-agent", () =>
          callTool(tools.createNotification, { body: "hi" }),
        ),
      );

      expect(result).toMatchObject({ source });
      expect(dispatchEvent).toHaveBeenCalledWith(orgId, workspaceId, {
        event: "notification.created",
        data: result,
      });
    },
  );

  it("listNotifications returns only this agent's, in this workspace, newest first, up to the limit", async () => {
    expect(await callTool(tools.listNotifications, {})).toMatchObject([
      { id: "mine-new" },
      { id: "mine-old" },
    ]);
    expect(await callTool(tools.listNotifications, { limit: 1 })).toMatchObject(
      [{ id: "mine-new" }],
    );
  });

  describe("updateNotification", () => {
    it("updates and dispatches, keeping its source", async () => {
      db.tables.notification[0].sourceChatId = "chat-1";
      const result: unknown = await withRunSource(
        { kind: "triggerRun", triggerRunId: "run-2" },
        () =>
          callTool(tools.updateNotification, {
            notificationId: "mine-old",
            body: "Updated",
          }),
      );

      expect(result).toMatchObject({
        id: "mine-old",
        body: "Updated",
        source: { kind: "chat", chatId: "chat-1" },
      });
      expect(dispatchEvent).toHaveBeenCalledWith(orgId, workspaceId, {
        event: "notification.updated",
        data: result,
      });
    });

    it.each(["other-agent", "other-workspace", "missing"])(
      "refuses %s",
      async (notificationId) => {
        expect(
          await callTool(tools.updateNotification, {
            notificationId,
            body: "Updated",
          }),
        ).toEqual({ error: "Notification not found" });
        expect(db.tables.notification.map((n) => n.body)).not.toContain(
          "Updated",
        );
        expect(dispatchEvent).not.toHaveBeenCalled();
      },
    );
  });

  describe("deleteNotification", () => {
    it("deletes and dispatches", async () => {
      expect(
        await callTool(tools.deleteNotification, {
          notificationId: "mine-old",
        }),
      ).toEqual({ success: true });
      expect(db.tables.notification.map((n) => n.id)).not.toContain("mine-old");
      expect(dispatchEvent).toHaveBeenCalledWith(orgId, workspaceId, {
        event: "notification.dismissed",
        data: { notificationId: "mine-old" },
      });
    });

    it.each(["other-agent", "other-workspace", "missing"])(
      "refuses %s",
      async (notificationId) => {
        expect(
          await callTool(tools.deleteNotification, { notificationId }),
        ).toEqual({ error: "Notification not found" });
        expect(db.tables.notification).toHaveLength(4);
        expect(dispatchEvent).not.toHaveBeenCalled();
      },
    );
  });
});
