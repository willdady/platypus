import { tool } from "ai";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";

const TIMEZONE = process.env.TIMEZONE || "UTC";

export const getCurrentTime = tool({
  description:
    "Get the current date and time. Use this when the user asks what time it is, what day it is, or needs to know the current date.",
  inputSchema: z.object({}),
  execute: async () => {
    const now = new Date();
    const formatted = formatInTimeZone(
      now,
      TIMEZONE,
      "EEEE, MMMM d, yyyy 'at' h:mm:ss a zzz",
    );

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
  execute: async ({ dateTime, fromTimezone, toTimezone }) => {
    // Parse the input date
    const date = new Date(dateTime);

    if (isNaN(date.getTime())) {
      throw new Error(`Invalid date format: ${dateTime}`);
    }

    // Format as ISO datetime in the target timezone
    const isoDateTime = formatInTimeZone(
      date,
      toTimezone,
      "yyyy-MM-dd'T'HH:mm:ssXXX",
    );

    return {
      originalDateTime: dateTime,
      fromTimezone,
      toTimezone,
      isoDateTime,
    };
  },
});
