import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { errorMessage } from "./error-message.ts";
import { env } from "../env.ts";

/**
 * Core's egress guard for **model-supplied** URLs (ADR-0014).
 *
 * Any tool that fetches a URL the *model* chose — `fetchUrl` today, a Web-search
 * backend's `read_url` next — runs the target through here first. Without it a
 * prompt-injected page can talk the model into fetching cloud-metadata
 * endpoints, loopback services, or internal hosts, all of which the backend
 * process can reach directly.
 *
 * The threat model is a **prompt-injected model**, not a malicious Plugin: a
 * Plugin already runs in-process with `process.env`, the database credentials,
 * and unrestricted egress (ADR-0013), so it never needed `read_url` to reach a
 * metadata service. That is why a pre-flight check is worth having even though
 * it cannot be complete (see the re-resolution limitation below).
 *
 * The posture is **inverted** from a naive default-deny, because self-hosted and
 * intranet deployments are the point of the Web-search Extension point: reading
 * the internal wiki must keep working, so RFC-1918 is allowed by default and the
 * Operator opts into denying it. What is blocked unconditionally is the set of
 * addresses no legitimate page read targets — loopback (where Platypus's own API
 * and Postgres listen), link-local (AWS/Azure/GCP metadata), and carrier-grade
 * NAT (Alibaba's metadata service lives at `100.100.100.200`).
 *
 * **Redirects** are followed hop by hop by {@link guardedFetch}, which runs
 * every hop through this guard — core never lets `fetch()` follow one itself.
 *
 * **Known limitation, by design: re-resolution.** `fetch()` resolves the
 * hostname again, independently of the lookup here, so a name whose records
 * change in between (DNS rebinding) can be checked as public and fetched as
 * internal. Closing it would mean pinning the vetted address and connecting to
 * it directly, which breaks TLS SNI and virtual hosting. That is why the guard
 * is scoped to a prompt-injected model rather than sold as an SSRF boundary: it
 * removes the easy path, not every path.
 *
 * MCP URLs (an Operator's or delegated Workspace Owner's input) run through
 * here too, with loopback re-allowed only when the Operator opts in.
 *
 * Webhook delivery also runs user-supplied URLs through here, and closes the
 * redirect gap itself by not following redirects.
 */

export type EgressVerdict =
  { allowed: true } | { allowed: false; reason: string };

/**
 * The single message a blocked fetch reports to the model, whatever the cause.
 * Deliberately uniform: a per-reason message would let a model distinguish "that
 * host does not resolve" from "that host resolves somewhere I may not go", which
 * turns the guard into a probe for internal DNS. The specific reason goes to the
 * server log instead.
 */
export const EGRESS_BLOCKED_MESSAGE =
  "Fetching this URL is not permitted by this deployment's network policy.";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

interface EgressRule {
  label: string;
  blockList: BlockList;
  /** Lifted by `allowLoopback` (MCP URLs, when the Operator opts in). */
  loopback?: true;
}

const rule = (
  cidr: string,
  label: string,
  family: "ipv4" | "ipv6",
): EgressRule => {
  const [address, bits] = cidr.split("/");
  const blockList = new BlockList();
  blockList.addSubnet(address ?? "", Number(bits), family);
  return { label, blockList };
};

const ipv4CompatibleRule: EgressRule = {
  label: "deprecated IPv4-compatible address",
  blockList: new BlockList(),
};
ipv4CompatibleRule.blockList.addRange("::2", "::ffff:ffff", "ipv6");

const loopbackRule = (entry: EgressRule): EgressRule => ({
  ...entry,
  loopback: true,
});

const v4Rule = (cidr: string, label: string): EgressRule =>
  rule(cidr, label, "ipv4");

const v6Rule = (cidr: string, label: string): EgressRule =>
  rule(cidr, label, "ipv6");

// Blocked whatever `allowPrivateNetworks` says: nothing a page read legitimately
// targets lives here, and each one is a known SSRF destination.
//
// The v4 rules also cover IPv4-mapped IPv6 literals (`::ffff:a9fe:a9fe`):
// `BlockList.check` with `'ipv6'` consults the list's v4 subnets. The deprecated
// IPv4-compatible form (`::169.254.169.254`) is not mapped, so `::/96` covers it
// wholesale — no legitimate page read targets an address in that form.
const ALWAYS_BLOCKED: readonly EgressRule[] = [
  // 0.0.0.0/8 sits with loopback rather than with "reserved": on Linux
  // `http://0.0.0.0:5432/` reaches a service listening on localhost.
  v4Rule("0.0.0.0/8", "this-host range, reaches localhost"),
  loopbackRule(v4Rule("127.0.0.0/8", "loopback")),
  v4Rule("169.254.0.0/16", "link-local, hosts cloud metadata services"),
  v4Rule("100.64.0.0/10", "carrier-grade NAT, hosts Alibaba cloud metadata"),
  v4Rule("192.0.0.0/24", "IETF protocol assignments"),
  v4Rule("198.18.0.0/15", "benchmarking"),
  v4Rule("224.0.0.0/4", "multicast"),
  v4Rule("240.0.0.0/4", "reserved, includes broadcast"),
  v6Rule("::/128", "unspecified address"),
  loopbackRule(v6Rule("::1/128", "loopback")),
  v6Rule("fe80::/10", "link-local"),
  v6Rule("fec0::/10", "deprecated site-local"),
  v6Rule("ff00::/8", "multicast"),
  // `::/96` less `::` and `::1`, which have rules of their own — so lifting
  // loopback lifts `::1` too.
  ipv4CompatibleRule,
  // Inside fc00::/7, which is only blocked when private networks are denied —
  // so it is listed here on its own.
  v6Rule("fd00:ec2::254/128", "AWS IPv6 metadata service"),
  // Local-use NAT64: where the IPv4 address sits depends on the prefix length
  // the network chose, so it cannot be extracted reliably. Blocked wholesale.
  v6Rule("64:ff9b:1::/48", "local-use NAT64"),
];

// Blocked only when the Operator sets EGRESS_ALLOW_PRIVATE_NETWORKS=false.
// Allowed by default so intranet page reads — the reason the Web-search
// Extension point exists — keep working.
const PRIVATE: readonly EgressRule[] = [
  v4Rule("10.0.0.0/8", "private network"),
  v4Rule("172.16.0.0/12", "private network"),
  v4Rule("192.168.0.0/16", "private network"),
  v6Rule("fc00::/7", "unique local address"),
];

/** The eight 16-bit groups of an address `isIP` already accepted as v6. */
const ipv6Groups = (address: string): number[] => {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const fill =
    tail === undefined
      ? []
      : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...fill, ...back].map((group) => parseInt(group, 16));
};

const ipv4From = (high: number, low: number): string =>
  `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/**
 * The IPv4 address a translation form carries — NAT64 `64:ff9b::/96`, 6to4
 * `2002::/16`, IPv4-translated `::ffff:0:0:0/96` — or `null`. Such an address
 * reaches the embedded one through a gateway, so the embedded one is what the
 * rules judge. (IPv4-mapped `::ffff:0:0/96` needs nothing here: `BlockList`
 * already checks it against the v4 rules.)
 */
const embeddedIpv4 = (address: string): string | null => {
  const g = ipv6Groups(address);
  const zeros = (from: number, to: number) =>
    g.slice(from, to).every((group) => group === 0);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) {
    return ipv4From(g[6] ?? 0, g[7] ?? 0);
  }
  if (g[0] === 0x2002) return ipv4From(g[1] ?? 0, g[2] ?? 0);
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) {
    return ipv4From(g[6] ?? 0, g[7] ?? 0);
  }
  return null;
};

/**
 * Why `address` may not be fetched, or `null` when it may. Anything that fails
 * to parse is blocked: an address form this guard does not recognise is an
 * address it cannot vouch for.
 */
const blockReasonFor = (
  address: string,
  allowPrivateNetworks: boolean,
  allowLoopback: boolean,
): string | null => {
  // A zone id (`fe80::1%eth0`) scopes the address to an interface; it does not
  // change which network the address is on. Drop it so it cannot hide an
  // address from the rules.
  const bare = address.split("%")[0] ?? "";
  const family = isIP(bare);
  if (family !== 4 && family !== 6) {
    return "unrecognised address form";
  }
  const type = family === 4 ? "ipv4" : "ipv6";
  const rules = [
    ...ALWAYS_BLOCKED,
    ...(allowPrivateNetworks ? [] : PRIVATE),
  ].filter((entry) => !(allowLoopback && entry.loopback));

  const direct = rules.find((entry) => entry.blockList.check(bare, type));
  if (direct) return direct.label;

  const embedded = family === 6 ? embeddedIpv4(bare) : null;
  if (!embedded) return null;
  const reason = blockReasonFor(embedded, allowPrivateNetworks, allowLoopback);
  return reason && `embeds ${embedded}, ${reason}`;
};

const privateNetworksAllowedByEnv = (): boolean =>
  env().EGRESS_ALLOW_PRIVATE_NETWORKS;

const resolveHostname = async (hostname: string): Promise<string[]> => {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

export interface CheckEgressOptions {
  /**
   * Allow RFC-1918 and unique-local addresses. Defaults to the
   * `EGRESS_ALLOW_PRIVATE_NETWORKS` env var (anything but `false`/`0` allows).
   */
  allowPrivateNetworks?: boolean;
  /**
   * Allow loopback (`127.0.0.0/8`, `::1`). Only MCP URLs set it, from
   * `EGRESS_ALLOW_LOOPBACK_MCP`; a model-supplied URL never may.
   */
  allowLoopback?: boolean;
  /** Hostname resolver. Injected by tests; defaults to a DNS lookup. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * Whether a model-supplied URL may be fetched.
 *
 * Hostnames are **resolved** rather than pattern-matched, because the string
 * form of a URL says little about where it goes: `metadata.google.internal` and
 * `169-254-169-254.nip.io` both land on the metadata service while looking
 * ordinary. (Numeric encodings — `http://2852039166/`, `http://0x7f000001/` —
 * need no special handling: WHATWG URL parsing normalises them to dotted quads
 * before this ever sees the hostname.) **Every** resolved address must pass, so
 * a name with one public and one internal record is refused.
 *
 * Fails closed: an unresolvable host is blocked rather than allowed. Such a
 * fetch would fail anyway, so nothing legitimate is lost.
 */
export const checkEgress = async (
  rawUrl: string,
  options: CheckEgressOptions = {},
): Promise<EgressVerdict> => {
  const allowPrivateNetworks =
    options.allowPrivateNetworks ?? privateNetworksAllowedByEnv();
  const resolve = options.resolve ?? resolveHostname;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: `'${rawUrl}' is not a valid URL` };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: `scheme '${url.protocol}' is not http or https`,
    };
  }

  // `URL.hostname` keeps the brackets on an IPv6 literal; `isIP` and the DNS
  // resolver both want them gone.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) {
    return { allowed: false, reason: `'${rawUrl}' has no host` };
  }

  let addresses: string[];
  if (isIP(hostname) !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await resolve(hostname);
    } catch (error) {
      return {
        allowed: false,
        reason: `'${hostname}' could not be resolved (${errorMessage(error)})`,
      };
    }
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `'${hostname}' resolved to no addresses` };
  }

  for (const address of addresses) {
    const blocked = blockReasonFor(
      address,
      allowPrivateNetworks,
      options.allowLoopback ?? false,
    );
    if (blocked) {
      return {
        allowed: false,
        reason: `'${hostname}' resolves to ${address} (${blocked})`,
      };
    }
  }

  return { allowed: true };
};

/** Redirects {@link guardedFetch} follows before giving up. */
export const MAX_REDIRECTS = 5;

/** Bytes of a response body {@link guardedFetch} reads; the rest is never buffered. */
export const MAX_FETCH_BODY_BYTES = 5 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type GuardedFetchResult =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      response: Response;
      /** The last hop's URL. */
      url: string;
      /** The body, decoded as UTF-8, up to `MAX_FETCH_BODY_BYTES`. */
      text: string;
      /** Whether the body ran past `MAX_FETCH_BODY_BYTES` and was cut there. */
      truncated: boolean;
    };

/** Reads at most `maxBytes` of `response`'s body, cancelling the rest. */
const readCapped = async (
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
};

/**
 * The only way core fetches a URL a model supplied: every hop of a redirect
 * chain is checked by {@link checkEgress} before a connection is opened to it,
 * and the body is read up to `MAX_FETCH_BODY_BYTES`. A chain longer than `MAX_REDIRECTS`
 * throws, as `fetch()` itself does.
 */
export const guardedFetch = async (
  rawUrl: string,
  init: Omit<RequestInit, "redirect"> = {},
): Promise<GuardedFetchResult> => {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    const verdict = await checkEgress(url);
    if (!verdict.allowed) return verdict;

    const response = await fetch(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return {
        allowed: true,
        response,
        url,
        ...(await readCapped(response, MAX_FETCH_BODY_BYTES)),
      };
    }
    await response.body?.cancel();
    if (hop === MAX_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
    }
    url = new URL(location, url).toString();
  }
};
