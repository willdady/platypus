import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

const valid = { ALLOWED_ORIGINS: "http://localhost:3001" };

describe("parseEnv", () => {
  it("applies the defaults to a minimal environment", () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(4001);
    expect(env.SCHEDULE_MAX_CONCURRENT).toBe(5);
    expect(env.STORAGE_BACKEND).toBe("disk");
    expect(env.EGRESS_ALLOW_PRIVATE_NETWORKS).toBe(true);
  });

  it("refuses a missing required variable", () => {
    expect(() => parseEnv({})).toThrow(/ALLOWED_ORIGINS/);
  });

  it("refuses a non-numeric interval instead of becoming NaN", () => {
    expect(() =>
      parseEnv({ ...valid, SCHEDULE_SCHEDULER_INTERVAL_MS: "1m" }),
    ).toThrow(/SCHEDULE_SCHEDULER_INTERVAL_MS/);
  });

  it("refuses zero where a positive number is required", () => {
    expect(() => parseEnv({ ...valid, INVITATION_EXPIRY_DAYS: "0" })).toThrow(
      /INVITATION_EXPIRY_DAYS/,
    );
  });

  it("accepts SCHEDULE_MAX_CONCURRENT=0, which pauses Cron Triggers", () => {
    expect(
      parseEnv({ ...valid, SCHEDULE_MAX_CONCURRENT: "0" })
        .SCHEDULE_MAX_CONCURRENT,
    ).toBe(0);
  });

  it("names every invalid variable at once", () => {
    expect(() =>
      parseEnv({ PORT: "abc", STORAGE_BACKEND: "nfs", TIMEZONE: "Mars/Base" }),
    ).toThrow(/PORT.*ALLOWED_ORIGINS.*TIMEZONE.*STORAGE_BACKEND/);
  });

  it("trims comma-list entries and refuses an empty one", () => {
    expect(
      parseEnv({ ALLOWED_ORIGINS: " http://a.test , http://b.test " })
        .ALLOWED_ORIGINS,
    ).toEqual(["http://a.test", "http://b.test"]);
    expect(() => parseEnv({ ALLOWED_ORIGINS: "http://a.test,," })).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  it("treats an empty value as unset", () => {
    expect(parseEnv({ ...valid, PORT: " " }).PORT).toBe(4001);
  });

  it("refuses an unrecognised boolean", () => {
    expect(() =>
      parseEnv({ ...valid, EGRESS_ALLOW_PRIVATE_NETWORKS: "yes" }),
    ).toThrow(/EGRESS_ALLOW_PRIVATE_NETWORKS/);
  });

  it("requires the S3 bucket only when STORAGE_BACKEND=s3", () => {
    expect(() => parseEnv({ ...valid, STORAGE_BACKEND: "s3" })).toThrow(
      /STORAGE_S3_BUCKET/,
    );
    expect(() =>
      parseEnv({ ...valid, STORAGE_BACKEND: "s3", STORAGE_S3_BUCKET: "b" }),
    ).not.toThrow();
  });

  it.each([
    ["STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"],
    ["STORAGE_S3_SECRET_ACCESS_KEY", "STORAGE_S3_ACCESS_KEY_ID"],
  ])("refuses %s without %s, naming both", (set, missing) => {
    expect(() =>
      parseEnv({
        ...valid,
        STORAGE_BACKEND: "s3",
        STORAGE_S3_BUCKET: "b",
        [set]: "x",
      }),
    ).toThrow(new RegExp(`${missing}: is required when ${set} is set`));
  });
});
