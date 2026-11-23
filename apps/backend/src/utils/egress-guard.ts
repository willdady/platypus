import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { errorMessage } from "./error-message.ts";
import { env } from "../env.ts";

export type EgressVerdict =
  { allowed: true } | { allowed: false; reason: string };

export const EGRESS_BLOCKED_MESSAGE =
  "Fetching this URL is not permitted by this deployment's network policy.";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

interface EgressRule {
  label: string;
  blockList: BlockList;
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

const ALWAYS_BLOCKED: readonly EgressRule[] = [
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
  ipv4CompatibleRule,
  v6Rule("fd00:ec2::254/128", "AWS IPv6 metadata service"),
  v6Rule("64:ff9b:1::/48", "local-use NAT64"),
];

const PRIVATE: readonly EgressRule[] = [
  v4Rule("10.0.0.0/8", "private network"),
  v4Rule("172.16.0.0/12", "private network"),
  v4Rule("192.168.0.0/16", "private network"),
  v6Rule("fc00::/7", "unique local address"),
];

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

const blockReasonFor = (
  address: string,
  allowPrivateNetworks: boolean,
  allowLoopback: boolean,
): string | null => {
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
  allowPrivateNetworks?: boolean;
  allowLoopback?: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
}

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

export const MAX_REDIRECTS = 5;

export const MAX_FETCH_BODY_BYTES = 5 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type GuardedFetchResult =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      response: Response;
      url: string;
      text: string;
      truncated: boolean;
    };

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
