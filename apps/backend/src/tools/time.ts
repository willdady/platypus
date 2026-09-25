import { tool } from "ai";
import { z } from "zod";

const TIMEZONE = process.env.TIMEZONE || "UTC";

/** A trailing `Z`/`±HH:MM`/`±HHMM`, or a `GMT`/`UTC` marker. */
const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$|\b(?:GMT|UTC)\b/i;

/** `timeZone`'s offset from UTC at `instant`, in ms. */
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
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * Parses `dateTime`, reading a zone-less value as a wall clock in `timeZone`.
 * A value carrying its own offset keeps it.
 */
function parseInZone(dateTime: string, timeZone: string): Date {
  const trimmed = dateTime.trim();
  if (EXPLICIT_OFFSET.test(trimmed)) return new Date(trimmed);

  // Date parses a zone-less value as server-local (a bare ISO date as UTC, so
  // give it a time); read it back as a wall clock and re-anchor it in timeZone
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
  // Second pass corrects for an offset that differs either side of a DST change
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(guess, timeZone));
}

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
    // output stays valid ISO. UTC is "GMT" or "GMT+00:00" depending on the
    // ICU version; both become Z
    const offset =
      parts.timeZoneName.replace(/^GMT(\+00:00)?/, "").replace("−", "-") || "Z";
    const isoDateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;

    return {
      originalDateTime: dateTime,
      fromTimezone,
      toTimezone,
      isoDateTime,
    };
  },
});
