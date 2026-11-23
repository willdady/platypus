import { tool } from "ai";
import { z } from "zod";

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$|\b(?:GMT|UTC)\b/i;

function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  );
  const { year, month, day, hour, minute, second } = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new Error(`No full date-time for ${timeZone}`);
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  return wall - Math.floor(instant / 1000) * 1000;
}

function parseInZone(dateTime: string, timeZone: string): Date {
  const trimmed = dateTime.trim();
  if (EXPLICIT_OFFSET.test(trimmed)) return new Date(trimmed);

  const local = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00` : trimmed,
  );
  if (isNaN(local.getTime())) return local;
  const wall = Date.UTC(
    local.getFullYear(),
    local.getMonth(),
    local.getDate(),
    local.getHours(),
    local.getMinutes(),
    local.getSeconds(),
    local.getMilliseconds(),
  );
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(guess, timeZone));
}

export const createGetCurrentTime = (timezone: string) =>
  tool({
    description:
      "Get the current date and time. Use this when the user asks what time it is, what day it is, or needs to know the current date.",
    inputSchema: z.object({}),
    execute: () => {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: timezone,
      }).format(now);

      return {
        timezone,
        timestamp: now.toISOString(),
        formatted,
      };
    },
  });

export const convertTimezone = tool({
  description:
    "Convert a given date/time from one timezone to another. Use this when the user needs to know what time it will be in a different timezone.",
  inputSchema: z.object({
    dateTime: z
      .string()
      .describe(
        'ISO 8601 date-time string or human-readable date string (e.g., "2025-01-07T14:30:00Z", "2025-01-07 14:30"). A value without an offset is read in fromTimezone.',
      ),
    fromTimezone: z
      .string()
      .describe(
        'Source IANA timezone name (e.g., "America/New_York"). Use "UTC" if the input is already in UTC.',
      )
      .default("UTC"),
    toTimezone: z
      .string()
      .describe(
        'Target IANA timezone name (e.g., "Europe/London", "Asia/Tokyo").',
      ),
  }),
  execute: ({ dateTime, fromTimezone, toTimezone }) => {
    const date = parseInZone(dateTime, fromTimezone);

    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date format: ${dateTime}`);
    }

    const formatter = new Intl.DateTimeFormat("sv-SE", {
      timeZone: toTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZoneName: "longOffset",
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((p) => [p.type, p.value]),
    );
    const { timeZoneName } = parts;
    if (timeZoneName === undefined) {
      throw new Error(`No offset for ${toTimezone}`);
    }
    const offset =
      timeZoneName.replace(/^GMT(\+00:00)?/, "").replace("−", "-") || "Z";
    const isoDateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;

    return {
      originalDateTime: dateTime,
      fromTimezone,
      toTimezone,
      isoDateTime,
    };
  },
});

export const createTimeTools = (timezone: string) => ({
  getCurrentTime: createGetCurrentTime(timezone),
  convertTimezone,
});
