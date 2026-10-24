import { describe, it, expect, vi } from "vitest";
import { pingDatabase, DB_PING_TIMEOUT_MS } from "./ready.ts";

describe("pingDatabase", () => {
  it("resolves true when SELECT 1 answers", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });

    expect(await pingDatabase({ query })).toBe(true);
    expect(query).toHaveBeenCalledWith({
      text: "SELECT 1",
      query_timeout: DB_PING_TIMEOUT_MS,
    });
  });

  it("resolves false when the query rejects", async () => {
    const query = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    expect(await pingDatabase({ query })).toBe(false);
  });

  it("resolves false when the pool never produces a client within the bound", async () => {
    vi.useFakeTimers();
    const hanging = new Promise<never>(() => {});
    const query = vi.fn().mockReturnValue(hanging);

    const ping = pingDatabase({ query }, 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await ping).toBe(false);
    vi.useRealTimers();
  });
});
