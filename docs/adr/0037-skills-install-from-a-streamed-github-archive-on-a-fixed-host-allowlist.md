---
status: accepted-pending-implementation
implemented-by: "#1386"
---

# Skills install from a streamed GitHub archive on a fixed host allowlist

> State of the code today: a Skill bundle can only be created or replaced from an
> uploaded zip, nothing fetches Skills from GitHub, and no Org gate restricts
> importing. This ADR records the decision only. It moves to `accepted` in the
> pull request that builds the install.

Installing Skills from GitHub resolves the ref to a commit SHA through the REST API, then streams that commit's zip archive from codeload and decompresses only the entries under the selected Skill paths, in memory. Every preview, install and update check costs one REST request and one download, whatever the number of Skills or files. Only `api.github.com` and `codeload.github.com` are contacted. Users supply an owner, repo, ref and path, never a URL, so no user-chosen host reaches `fetch` and the egress guard (ADR-0014) isn't involved. Importing third-party bundles at Workspace scope sits behind an Org gate (`off | selected | all`, as in ADR-0030 and ADR-0032) that defaults to `all`. Skills are composition (ADR-0006), and their scripts only run in a Sandbox, which only an Org Admin configures.

## Considered Options

- **A shallow `git clone` to a temp directory** (what the `skills` CLI does). Rejected: it needs git in the image and writes repo symlinks to disk, which the importer would then have to refuse to follow. It also merges case-variant paths on case-insensitive disks, needs temp cleanup after a crash, and downloads the same amount.
- **The Trees API plus one `raw.githubusercontent.com` fetch per file.** Rejected: it costs N requests per Skill against an unpublished anonymous limit, and a recursive tree can come back truncated.
- **skills.sh search and download.** Rejected: the API is undocumented.
- **A default-off gate** (ADR-0006's posture). Rejected: it would break zip import, which had already shipped, for every existing Workspace, and Skills aren't credential- or reach-bearing.

## Consequences

- The whole repo archive streams through the backend, so a Skill in a large monorepo can exceed the fixed 100 MiB archive cap and can't be installed.
- Without `GITHUB_TOKEN`, all installs share 60 REST requests per hour per deployment IP.
- The gate stops third-party bundles, not harmful instructions typed into a Skill's body.
