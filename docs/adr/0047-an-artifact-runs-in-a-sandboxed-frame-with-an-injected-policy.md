---
status: accepted
---

# An Artifact runs in a sandboxed frame with an injected policy

An HTML or SVG Artifact is a page an Agent wrote, possibly while reading a
poisoned web page or document, so the viewer treats it as hostile. It runs in an
`iframe` fed by `srcDoc` — never a URL on the app or API origin — under exactly
`sandbox="allow-scripts"`. Without `allow-same-origin` the frame gets an opaque
origin: no session cookie, no storage, no reach into the Platypus page, and no
popups, forms or top-level navigation. The document builder prepends a
Content-Security-Policy `<meta>` before anything the model or the User wrote, so
a later policy in the content can only tighten it. The policy keeps
`default-src`, `connect-src`, `form-action` and `base-uri` at `'none'` and
allows scripts, styles and fonts only from the `https` origins in
`ARTIFACT_SCRIPT_ORIGINS`. SVG is wrapped in a minimal document so script inside
it is held to the same rules. The embedding page sends `frame-src 'none'` as
well: the frame's own policy cannot stop the frame navigating itself to another
URL and carrying data out in the query string, and the frontend has no other
frames for that directive to affect.

There is no scan of script sources when an Artifact is created or uploaded. A
static scan cannot see a script a page adds at runtime, and it goes stale the
moment an Operator changes the approved list; enforcement happens at view time,
where the browser applies the policy the deployment actually has. Uploads reach
the same frame as Agent-written content, so uploading is not a way around this.

A small prelude in the frame reports each blocked request to the viewer, which
shows a notice naming the origin. The notice is informational: containment
rests on the sandbox and the policy, and the viewer accepts reports only from
its own frame's `contentWindow`. A deployment that approves a CDN carrying
user-published content lets anyone run a script inside an Artifact; it still
cannot read the User's session or send data out, and the Operator documentation
says what they are approving.

## Considered Options

- **Serve Artifact content from a separate origin.** Rejected for this slice: it
  needs another origin per deployment, and it would still leave the frame able
  to reach the network and navigate itself without the injected policy and
  `frame-src 'none'`.
- **Scan script sources at creation and upload time.** Rejected: runtime-added
  scripts evade it, and a stored verdict is wrong as soon as the Operator edits
  the approved list.
- **Allow `allow-scripts allow-same-origin`.** Rejected: same-origin is what
  gives the frame the User's session, so the two together defeat the boundary.
