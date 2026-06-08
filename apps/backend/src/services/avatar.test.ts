import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(),
}));

const metadataMock = vi.fn();
const toBufferMock = vi.fn();
const resizeMock = vi.fn().mockReturnThis();
const webpMock = vi.fn().mockReturnThis();

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    metadata: metadataMock,
    resize: resizeMock,
    webp: webpMock,
    toBuffer: toBufferMock,
  })),
}));

import { storeAvatar, deleteAvatar } from "./avatar.ts";
import { getStorage } from "../storage/index.ts";

const putMock = vi.fn();
const deleteMock = vi.fn();
const mockStorage = { get: vi.fn(), put: putMock, delete: deleteMock };

/** A real File so `instanceof File`, `.type`, `.size`, and `.arrayBuffer()` behave. */
function makeFile(bytes: number, type: string): File {
  return new File([Buffer.alloc(bytes)], "avatar", { type });
}

describe("storeAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getStorage as ReturnType<typeof vi.fn>).mockReturnValue(mockStorage);
    resizeMock.mockReturnThis();
    webpMock.mockReturnThis();
    metadataMock.mockResolvedValue({ width: 512, height: 512 });
    toBufferMock.mockResolvedValue(Buffer.from("processed"));
  });

  it("rejects a missing or non-File value without touching storage", async () => {
    const result = await storeAvatar(undefined, "agent-1", null);
    expect(result).toEqual({ ok: false, error: "No file provided" });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported content type", async () => {
    const result = await storeAvatar(
      makeFile(10, "image/svg+xml"),
      "agent-1",
      null,
    );
    expect(result).toEqual({ ok: false, error: "Invalid file type" });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects a file over the 5MB limit", async () => {
    const result = await storeAvatar(
      makeFile(5 * 1024 * 1024 + 1, "image/png"),
      "agent-1",
      null,
    );
    expect(result).toEqual({ ok: false, error: "File too large (max 5MB)" });
  });

  it("rejects a file sharp cannot decode as an image", async () => {
    metadataMock.mockRejectedValueOnce(new Error("bad"));
    const result = await storeAvatar(
      makeFile(10, "image/png"),
      "agent-1",
      null,
    );
    expect(result).toEqual({ ok: false, error: "Invalid image" });
    expect(putMock).not.toHaveBeenCalled();
  });

  it("rejects an image smaller than the minimum dimension", async () => {
    metadataMock.mockResolvedValueOnce({ width: 32, height: 32 });
    const result = await storeAvatar(
      makeFile(10, "image/png"),
      "agent-1",
      null,
    );
    expect(result).toEqual({
      ok: false,
      error: "Image must be at least 64x64 pixels",
    });
  });

  it("stores a processed webp under an agent-scoped key and returns it", async () => {
    const result = await storeAvatar(
      makeFile(10, "image/png"),
      "agent-1",
      null,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.key).toMatch(/^agents\/agent-1\/avatar-.+\.webp$/);
    expect(resizeMock).toHaveBeenCalledWith(512, 512, { fit: "cover" });
    expect(putMock).toHaveBeenCalledWith(
      result.key,
      expect.any(Buffer),
      "image/webp",
    );
  });

  it("deletes the previous avatar before storing the replacement", async () => {
    const result = await storeAvatar(
      makeFile(10, "image/png"),
      "agent-1",
      "agents/agent-1/avatar-old.webp",
    );
    expect(result.ok).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith("agents/agent-1/avatar-old.webp");
    expect(putMock).toHaveBeenCalled();
  });
});

describe("deleteAvatar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getStorage as ReturnType<typeof vi.fn>).mockReturnValue(mockStorage);
  });

  it("is a no-op when no key is present", async () => {
    await deleteAvatar(null);
    await deleteAvatar(undefined);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes the keyed object from storage", async () => {
    await deleteAvatar("agents/agent-1/avatar-x.webp");
    expect(deleteMock).toHaveBeenCalledWith("agents/agent-1/avatar-x.webp");
  });

  it("swallows storage errors so the surrounding request still succeeds", async () => {
    deleteMock.mockRejectedValueOnce(new Error("gone"));
    await expect(
      deleteAvatar("agents/agent-1/avatar-x.webp"),
    ).resolves.toBeUndefined();
  });
});
