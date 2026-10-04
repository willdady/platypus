import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { InboundTokenStatus } from "@platypus/schemas";

/**
 * The Inbound Trigger token (ADR-0030): one bearer credential per Trigger that
 * grants exactly "run this Agent with this Instruction".
 *
 * Shown to the Owner once and stored only as a hash. Unlike a Webhook's
 * signing secret, which stays readable because HMAC needs it, nothing in
 * Platypus ever needs the token back. It is 256 random bits, so a fast hash is
 * enough: there is no low-entropy input for a slow one to protect.
 */

/**
 * Makes a leaked token recognisable — to a person reading a log, and to a
 * secret scanner — without carrying any meaning the backend relies on.
 */
const TOKEN_PREFIX = "pit_";

export const DAY_MS = 24 * 60 * 60 * 1000;

export const hashInboundToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/**
 * A fresh token, and the hash that is all the database keeps of it. A2A
 * tokens (ADR-0032) are made the same way under their own prefix.
 */
export const generateBearerToken = (
  prefix: string = TOKEN_PREFIX,
): { token: string; hash: string } => {
  const token = prefix + randomBytes(32).toString("base64url");
  return { token, hash: hashInboundToken(token) };
};

/**
 * Whether `presented` is the token `storedHash` was made from. Compares the
 * hashes in constant time, so the response time says nothing about how much of
 * a guess was right.
 */
export const inboundTokenMatches = (
  presented: string,
  storedHash: string,
): boolean => {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashInboundToken(presented), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/**
 * The Trigger columns a newly issued token writes. Clears the notice record,
 * because each expiry Notification is owed once per token, not per Trigger.
 */
export const issuedTokenFields = (
  hash: string,
  expiryDays: number,
  now: Date = new Date(),
) => ({
  tokenHash: hash,
  tokenCreatedAt: now,
  tokenExpiresAt: new Date(now.getTime() + expiryDays * DAY_MS),
  tokenNotice: null,
});

/**
 * How a Trigger's token stands: no token (never issued, or revoked), active,
 * expiring within 7 days, or expired. Every surface that shows it reads this.
 */
export const inboundTokenStatus = (
  trigger: { tokenHash: string | null; tokenExpiresAt: Date | null },
  now: Date = new Date(),
): InboundTokenStatus => {
  if (!trigger.tokenHash || !trigger.tokenExpiresAt) return "none";
  const left = trigger.tokenExpiresAt.getTime() - now.getTime();
  if (left <= 0) return "expired";
  return left <= 7 * DAY_MS ? "expiring" : "active";
};

/** The columns a revoke writes: no token, and nothing left to notify about. */
export const revokedTokenFields = () => ({
  tokenHash: null,
  tokenCreatedAt: null,
  tokenExpiresAt: null,
  tokenNotice: null,
});

/**
 * The expiry Notifications a token can be owed, in the order they fall due.
 * `tokenNotice` stores the latest one sent, so "has X been sent" is "is the
 * stored notice at or past X".
 */
export const TOKEN_NOTICES = ["expiring_30", "expiring_7", "expired"] as const;

export type TokenNotice = (typeof TOKEN_NOTICES)[number];

export const tokenNoticeSent = (
  stored: string | null,
  notice: TokenNotice,
): boolean =>
  stored != null &&
  TOKEN_NOTICES.indexOf(stored as TokenNotice) >= TOKEN_NOTICES.indexOf(notice);
