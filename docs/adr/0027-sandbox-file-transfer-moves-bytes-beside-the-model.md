---
status: accepted
---

# Sandbox file transfer moves bytes beside the model, not through it

A User can upload a file into a Workspace's Sandbox, or download one out of it,
without the model in the loop. The bytes move through two **optional**
`SandboxBackend` members — `fsReadBytes(ctx, { path, maxBytes }, options)` and
`fsWriteBytes(ctx, { path, bytes }, options)` — which are adapter capabilities,
never Tools. The five model-facing tools and their caps are unchanged: those caps
exist because tool output lands in model context, and a transfer never does. One
fixed bound, 25 MiB, applies in both directions on every backend.

The model gets one core-built Tool, `fsDownload`, in the `sandbox` Tool set. It
checks that a path exists and is within the bound, and returns the path and its
size — no URL. The result renders as a download button that builds the link
client-side, so the model has no link to paste or hand to another Tool; one can
be added to the result later without breaking anything. This amends ADR-0002 —
the Tool set is no longer exactly five tools — but not ADR-0002's adapter
contract: an adapter implements nothing for it beyond `fsReadBytes`.

## Decisions

- **Whole-file and capped** — no offsets, no streaming. Sandbox SDKs overwhelmingly
  expose whole-file byte get/put, which an offset contract would not map onto.
  Streaming (backpressure, abort) is a separate decision, if a need appears.
- **`fsReadBytes` rejects a file larger than `maxBytes`**, so an adapter can size
  a file before pulling it across. **`fsWriteBytes` always overwrites** and
  creates missing parent directories. Core owns create-versus-overwrite by
  probing with `fsList` before a create, because most provider write APIs have no
  create-only mode and a probe in every adapter is the same race N times. An
  upload onto a taken path answers 409 and the User confirms the overwrite.
- **An adapter honours the full bound or does not implement the members.** This
  is ADR-0002's rejection of adapter-defined bounds, applied again: a transport
  with a smaller request limit chunks internally.
- **No fallback.** An adapter without a member does not offer that direction: the
  Workspace UI says the backend doesn't support file transfer, and `fsDownload`
  is left out of the Tool set. The two members are gated independently.
- **A download link is an authenticated route, not a bearer token.** Redeeming it
  requires a session with Workspace access, the same rule as every Workspace
  route. It points at the path's _current_ content rather than a snapshot: it
  never expires, serves whatever the path holds now, and 404s once the Sandbox is
  gone. Nothing secret lands in a Transcript.
- **Every download is an `attachment`**, with `X-Content-Type-Options: nosniff`
  and a generic content type. Sandbox content is model- and User-authored and
  must never render in the application's origin.
- **Paths reuse the tool path schema, and `..` is not rejected.** Anyone who
  passes the Workspace access check can already run arbitrary shell in the
  Sandbox through an Agent, so `..` grants nothing; a guard would imply a
  boundary that does not exist. This stops holding if links ever become bearer
  capabilities.
- **The backend buffers each transfer in memory and never writes Sandbox content
  to its own disk or storage.**

## Considered Options

- **A text-only fallback over `fsRead` / `fsWrite`** (UTF-8, under 1 MB). Rejected:
  it fails exactly the files people want to move, and cannot be stretched —
  `fsRead`'s `lineRange` slices the already-capped prefix.
- **A base64 shim over the five tools** — encode and split in the shell, `fsRead`
  each chunk; the reverse for upload. Workable on any POSIX Sandbox at roughly
  one round trip per MB. Rejected because every provider surveyed in September
  2026 (Cloudflare Sandbox, E2B, Daytona, Modal, Vercel Sandbox) has a native
  binary-safe file API, and AWS Lambda MicroVMs has no exec or file API at all —
  its adapter must supply its own in-VM server, which can serve bytes directly.
  The shim would serve only adapters written before these members existed; it
  can be added later behind the same gating if one turns up.
- **Byte-returning model Tools.** Rejected: the model has no use for bytes, and
  such a Tool would bypass the bound that keeps tool output out of context. The
  model can already produce a binary file with `shellExec` and `base64 -d`.
- **Bearer-token links with a short TTL.** Rejected: a secret in a Transcript that
  can be shared or exported, and an expiry that breaks a link read later — a
  Trigger run's Chat, say.
- **Required members, via a major bump.** Rejected: core still loads N−1 plugins
  during the window, so the gating is needed either way.
- **`fsDownload` in a Tool set of its own.** Rejected: useless without `sandbox`,
  and it would have to be granted alongside it on every Agent.
- **An Operator-configurable bound.** Rejected on the same grounds as an
  adapter-defined one.

## Consequences

- The plugin SDK gains two optional members — an append-only, minor change.
- `createPosixSandbox` implements both over the transport's existing
  `readFile` / `writeFile`, so the Docker and SSH backends need no changes.
- A whole-file buffer costs two to three copies of the file per in-flight
  transfer, with no concurrency limit. Fine at self-hosted scale; streaming is
  the fix if it isn't.
- Uploading through the chat composer is not covered. It would overlap the File
  part, which is stored and routed to the model rather than placed in the
  Sandbox, and is left to a decision of its own (#1070).
