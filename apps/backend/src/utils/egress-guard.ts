import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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
 * it cannot be complete (see the redirect limitation below).
 *
 * The posture is **inverted** from a naive default-deny, because self-hosted and
 * intranet deployments are the point of the Web-search Extension point: reading
 * the internal wiki must keep working, so RFC-1918 is allowed by default and the
 * Operator opts into denying it. What is blocked unconditionally is the set of
 * addresses no legitimate page read targets — loopback (where Platypus's own API
 * and Postgres listen), link-local (AWS/Azure/GCP metadata), and carrier-grade
 * NAT (Alibaba's metadata service lives at `100.100.100.200`).
 *
 * **Known limitations, by design.** This is a *pre-flight* check on the URL the
 * model supplied, so two gaps stay open:
 *
 * 1. **Redirects.** The caller's HTTP client follows them, so a host that passes
 *    here and then 302s into a blocked range is not caught. Closing it would
 *    mean every caller driving redirects manually — rejected for v1 in ADR-0014
 *    as more machinery than the guarantee is worth.
 * 2. **Re-resolution.** `fetch()` resolves the hostname again, independently of
 *    the lookup here, so a name whose records change in between (DNS rebinding)
 *    can be checked as public and fetched as internal. Closing it would mean
 *    pinning the vetted address and connecting to it directly, which breaks TLS
 *    SNI and virtual hosting.
 *
 * Both are why the guard is scoped to a prompt-injected model rather than sold as
 * an SSRF boundary: it removes the easy path, not every path.
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
  v4Rule("127.0.0.0/8", "loopback"),
  v4Rule("169.254.0.0/16", "link-local, hosts cloud metadata services"),
  v4Rule("100.64.0.0/10", "carrier-grade NAT, hosts Alibaba cloud metadata"),
  v6Rule("::/128", "unspecified address"),
  v6Rule("::1/128", "loopback"),
  v6Rule("fe80::/10", "link-local"),
  v6Rule("::/96", "deprecated IPv4-compatible address"),
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

/**
 * Why `address` may not be fetched, or `null` when it may. Anything that fails
 * to parse is blocked: an address form this guard does not recognise is an
 * address it cannot vouch for.
 */
const blockReasonFor = (
  address: string,
  allowPrivateNetworks: boolean,
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
  const rules = allowPrivateNetworks
    ? ALWAYS_BLOCKED
    : [...ALWAYS_BLOCKED, ...PRIVATE];

  return (
    rules.find((entry) => entry.blockList.check(bare, type))?.label ?? null
  );
};

const privateNetworksAllowedByEnv = (): boolean => {
  const raw = process.env.EGRESS_ALLOW_PRIVATE_NETWORKS?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
};

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
        reason: `'${hostname}' could not be resolved (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
    }
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `'${hostname}' resolved to no addresses` };
  }

  for (const address of addresses) {
    const blocked = blockReasonFor(address, allowPrivateNetworks);
    if (blocked) {
      return {
        allowed: false,
        reason: `'${hostname}' resolves to ${address} (${blocked})`,
      };
    }
  }

  return { allowed: true };
};
