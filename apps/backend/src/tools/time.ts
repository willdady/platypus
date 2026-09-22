import { tool } from "ai";
import { z } from "zod";

const TIMEZONE = process.env.TIMEZONE || "UTC";

export const getCurrentTime = tool({
  description:
    "Get the current date and time. Use this when the user asks what time it is, what day it is, or needs to know the current date.",
  inputSchema: z.object({}),
  execute: () => {
    const now = new Date();
    const formatted = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: TIMEZONE,
    }).format(now);

    return {
      timezone: TIMEZONE,
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
        'ISO 8601 date-time string or human-readable date string (e.g., "2025-01-07T14:30:00Z", "2025-01-07 14:30").',
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
    // Parse the input date
    const date = new Date(dateTime);

    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date format: ${dateTime}`);
    }

    // sv-SE renders dates in near-ISO shape; assemble the parts manually to
    // get a T separator and an explicit offset like -05:00 (Z for UTC)
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
    // ICU renders the longOffset sign as U+2212; normalise to ASCII so the
    // output stays valid ISO
    const offset =
      parts.timeZoneName.replace(/^GMT/, "").replace("−", "-") || "Z";
    const isoDateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;

    return {
      originalDateTime: dateTime,
      fromTimezone,
      toTimezone,
      isoDateTime,
    };
  },
});
