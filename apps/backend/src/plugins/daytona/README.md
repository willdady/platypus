# @platypus/daytona

Core plugin that runs each Workspace's Sandbox on [Daytona](https://www.daytona.io)'s hosted sandboxes. A Workspace's sandbox, `platypus-<orgId>-<workspaceId>`, is created on its first tool call, started again after Daytona stops it, and deleted when the Sandbox is deleted.

## Setup

1. Create an API key in the Daytona dashboard.
2. List the plugin and supply the key in the backend's environment: the root `.env` for a Compose deployment (Compose loads it into the backend container), or `apps/backend/.env` under `pnpm dev`:

   ```
   PLATYPUS_PLUGINS=@platypus/web-fetch,@platypus/daytona
   PLATYPUS_PLUGIN_CONFIG_DAYTONA={"credentials":{"apiKey":"dtn_..."}}
   ```

3. Restart the backend. If the plugin is listed but has no API key, the backend fails at boot.
4. In the app, an Org Admin opens **Workspace settings → Sandbox** and picks **Daytona** as the backend. The backend has no per-Workspace settings.

The key applies to the whole deployment, so every Workspace's sandbox runs on that one Daytona account.

## Optional config

Add a `config` block next to `credentials` (`outboundProxyUrl` goes in `credentials`, since it may embed the proxy's password):

| Field              | Default           | Meaning                                         |
| ------------------ | ----------------- | ----------------------------------------------- |
| `apiUrl`           | Daytona's cloud   | API endpoint, for a self-hosted Daytona         |
| `target`           | Account default   | Region for new sandboxes, e.g. `us`, `eu`       |
| `snapshot`         | Daytona's default | Snapshot new sandboxes are created from         |
| `autoStopInterval` | `15`              | Idle minutes before Daytona stops it; `0` = off |
| `networkBlockAll`  | `false`           | Block all network access                        |
| `networkAllowList` | Unrestricted      | Allowed CIDR ranges, JSON array                 |
| `domainAllowList`  | Unrestricted      | Allowed domains, JSON array                     |
| `outboundProxyUrl` | None              | HTTP(S) proxy URL; in `credentials`             |

```
PLATYPUS_PLUGIN_CONFIG_DAYTONA={"config":{"target":"eu","domainAllowList":["github.com","pypi.org"]},"credentials":{"apiKey":"dtn_...","outboundProxyUrl":"http://user:pass@proxy.internal:3128"}}
```

Every field except `apiUrl` applies only to sandboxes created after the change. `outboundProxyUrl` only routes traffic: a process that clears its proxy variables bypasses it, unless `domainAllowList` is also set.

`networkBlockAll`, `networkAllowList` and `domainAllowList` depend on your [Daytona tier](https://www.daytona.io/docs/en/network-limits/). On Tier 1 and 2 your Daytona organization's restrictions win and can't be overridden per sandbox. Daytona doesn't say whether these fields are ignored or rejected there, so remove them if creates fail. On Tier 3 and 4 they replace the default full access, and an allowlist also blocks essential services (GitHub, npm, PyPI) unless you list them.

The Operator-facing docs are in `apps/docs/content/self-hosting/sandbox/daytona.mdx`.
