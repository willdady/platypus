import { tool } from "ai";
import { z } from "zod";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";
import { nanoid, customAlphabet } from "nanoid";

const LOWERCASE_ALPHANUMERIC = "0123456789abcdefghijklmnopqrstuvwxyz";
const ALPHANUMERIC =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const generateUuid = tool({
  description:
    "Generate one or more RFC 9562 UUIDs. Use this for a standard 36-character " +
    "(or 32-character, hyphen-free) interchange identifier — the default choice " +
    "when nothing narrower is required. For a short id that fits a length or " +
    "charset budget (e.g. a DNS label, an S3 or GCS bucket name), use " +
    "generateNanoId instead.",
  inputSchema: z.object({
    version: z
      .enum(["v4", "v7"])
      .default("v4")
      .describe(
        "UUID version: v4 (random, default) or v7 (time-ordered, useful as database primary keys).",
      ),
    format: z
      .enum(["standard", "no-hyphens"])
      .default("standard")
      .describe(
        "Output format: standard hyphenated lowercase (default) or no-hyphens (32-character hex, no hyphens).",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(1)
      .describe("How many UUIDs to generate (1-100, default 1)."),
  }),
  execute: ({ version, format, count }) => {
    const generate = version === "v7" ? uuidv7 : uuidv4;
    const ids = Array.from({ length: count }, () => {
      const id = generate();
      return format === "no-hyphens" ? id.replace(/-/g, "") : id;
    });

    return { ids, version, format, count };
  },
});

// "url-safe" has no pool here: it maps to nanoid's own built-in alphabet, used
// via the plain `nanoid()` call below rather than `customAlphabet`.
const ALPHABETS = {
  "lowercase-alphanumeric": LOWERCASE_ALPHANUMERIC,
  alphanumeric: ALPHANUMERIC,
  "url-safe": undefined,
} as const;

export const generateNanoId = tool({
  description:
    "Generate one or more short, unique nanoid identifiers. Use this when the " +
    "target has a length or charset budget (e.g. a DNS label, an S3 or GCS " +
    "bucket name, a k8s resource name) that a full UUID would not fit. For a " +
    "standard 36-character interchange identifier, use generateUuid instead. " +
    "The collision probability at a given size and alphabet is the caller's to " +
    "reason about — this tool only enforces sane bounds, not a safety guarantee.",
  inputSchema: z.object({
    size: z
      .number()
      .int()
      .min(8)
      .max(64)
      .default(21)
      .describe("Length of each id in characters (8-64, default 21)."),
    alphabet: z
      .enum(["lowercase-alphanumeric", "alphanumeric", "url-safe"])
      .default("lowercase-alphanumeric")
      .describe(
        "Character set to draw from: lowercase-alphanumeric [a-z0-9] (default, safe for DNS labels/S3/GCS), alphanumeric [A-Za-z0-9], or url-safe (nanoid's own 64-character alphabet, including - and _).",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(1)
      .describe("How many ids to generate (1-100, default 1)."),
  }),
  execute: ({ size, alphabet, count }) => {
    const pool = ALPHABETS[alphabet];
    const generate = pool ? customAlphabet(pool, size) : () => nanoid(size);
    const ids = Array.from({ length: count }, () => generate());

    return { ids, size, alphabet, count };
  },
});
