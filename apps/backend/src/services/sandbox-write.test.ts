import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

vi.mock("../sandbox/teardown.ts", () => ({ destroySandboxRow: vi.fn() }));

import { destroySandboxRow } from "../sandbox/teardown.ts";
import {
  createSandbox,
  deleteSandbox,
  updateSandbox,
} from "./sandbox-write.ts";
import { ConflictError, UpstreamError, ValidationError } from "../errors.ts";

const destroy = vi.mocked(destroySandboxRow);

const current = {
  id: "sbx-1",
  workspaceId: "ws-1",
  name: "Local",
  backend: "old-backend",
  config: {},
  credentials: { token: "t" },
  adminEnv: { TOKEN: "a" },
  userEnv: {},
};

const update = (backend = "old-backend") => ({
  name: "Renamed",
  backend,
  config: { image: "x" },
  credentials: { token: "new" },
  adminEnv: { OTHER: "b" },
  userEnv: { MINE: "c" },
});

const setFields = () => mockDb.set.mock.calls[0][0] as Record<string, unknown>;

describe("sandbox write model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockDb();
    mockDb.limit.mockResolvedValue([current]); // requireOwned
    mockDb.returning.mockResolvedValue([current]);
  });

  describe("createSandbox", () => {
    it("maps a unique violation on the Workspace to ConflictError", async () => {
      mockDb.returning.mockRejectedValueOnce({ code: "23505" });
      await expect(
        createSandbox("ws-1", { name: "L", backend: "docker" }),
      ).rejects.toThrow(ConflictError);
    });

    it("rejects an env collision before inserting", async () => {
      await expect(
        createSandbox("ws-1", {
          name: "L",
          backend: "docker",
          adminEnv: { TOKEN: "a" },
          userEnv: { TOKEN: "b" },
        }),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe("updateSandbox", () => {
    it("lets a non-admin Owner change only name and userEnv", async () => {
      await updateSandbox("ws-1", update("new-backend"), {
        isAdmin: false,
        force: false,
      });
      expect(setFields()).toEqual({
        name: "Renamed",
        userEnv: { MINE: "c" },
        updatedAt: expect.any(Date) as unknown,
      });
      expect(destroy).not.toHaveBeenCalled();
    });

    it("rejects a non-admin Owner's userEnv overriding an admin key", async () => {
      await expect(
        updateSandbox(
          "ws-1",
          { ...update(), userEnv: { TOKEN: "x" } },
          { isAdmin: false, force: false },
        ),
      ).rejects.toThrow(ValidationError);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("lets an admin change every field", async () => {
      await updateSandbox("ws-1", update(), { isAdmin: true, force: false });
      expect(setFields()).toEqual({
        ...update(),
        updatedAt: expect.any(Date) as unknown,
      });
      expect(destroy).not.toHaveBeenCalled();
    });

    it("destroys the old backend before switching", async () => {
      await updateSandbox("ws-1", update("new-backend"), {
        isAdmin: true,
        force: false,
      });
      expect(destroy).toHaveBeenCalledWith(current);
      expect(setFields().backend).toBe("new-backend");
    });

    it("throws UpstreamError and keeps the row when destroy fails", async () => {
      destroy.mockRejectedValueOnce(new Error("daemon down"));
      const result = updateSandbox("ws-1", update("new-backend"), {
        isAdmin: true,
        force: false,
      });
      await expect(result).rejects.toThrow(UpstreamError);
      await expect(result).rejects.toThrow(/daemon down.*force=true/);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("skips destroy when forced", async () => {
      await updateSandbox("ws-1", update("new-backend"), {
        isAdmin: true,
        force: true,
      });
      expect(destroy).not.toHaveBeenCalled();
      expect(setFields().backend).toBe("new-backend");
    });
  });

  describe("deleteSandbox", () => {
    it("destroys, then deletes the row", async () => {
      await deleteSandbox("ws-1", { force: false });
      expect(destroy).toHaveBeenCalledWith(current);
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it("throws UpstreamError and keeps the row when destroy fails", async () => {
      destroy.mockRejectedValueOnce(new Error("daemon down"));
      await expect(deleteSandbox("ws-1", { force: false })).rejects.toThrow(
        UpstreamError,
      );
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it("skips destroy when forced", async () => {
      await deleteSandbox("ws-1", { force: true });
      expect(destroy).not.toHaveBeenCalled();
      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});
