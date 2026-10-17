import { describe, it, expect } from "vitest";
import {
  buildCronExpression,
  parseCronExpression,
  type SimpleSchedule,
} from "./cron";

const build = (s: SimpleSchedule) =>
  buildCronExpression(s.frequency, s.minute, s.hour, s.dayOfWeek, s.dayOfMonth);

describe("cron helpers", () => {
  it.each([
    "*/5 * * * *",
    "*/10 * * * *",
    "*/15 * * * *",
    "*/30 * * * *",
    "5 * * * *",
    "30 9 * * *",
    "30 9 * * 1",
    "30 9 15 * *",
  ])("round-trips %s through the simple editor", (expression) => {
    const parsed = parseCronExpression(expression);
    expect(parsed).not.toBeNull();
    expect(build(parsed!)).toBe(expression);
  });

  it("reads each simple expression as its frequency", () => {
    expect(parseCronExpression("5 * * * *")?.frequency).toBe("hourly");
    expect(parseCronExpression("30 9 * * *")?.frequency).toBe("daily");
    expect(parseCronExpression("30 9 * * 1")).toMatchObject({
      frequency: "weekly",
      dayOfWeek: "1",
    });
    expect(parseCronExpression("30 9 15 * *")).toMatchObject({
      frequency: "monthly",
      dayOfMonth: "15",
    });
  });

  it.each(["0 9 1-5 * *", "0 9 * 1 *", "*/7 * * * *", "0 9 * *", "nonsense"])(
    "leaves %s to the raw expression editor",
    (expression) => {
      expect(parseCronExpression(expression)).toBeNull();
    },
  );
});
