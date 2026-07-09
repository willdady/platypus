import type {
  PlatypusPlugin,
  PluginConfigContext,
  SandboxBackend,
  SandboxBackendContribution,
  ToolSetContribution,
} from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { tool } from "ai";
import { z } from "zod";

// Example third-party plugin, kept as an in-repo reference for the deploy-time
// plugin-config + shared-credential mechanics of ADR-0013. It is NOT in the
// core allowlist (`builtin.ts`) and is NOT listed in any default
// `PLATYPUS_PLUGINS`, so it never loads in a real deployment — it exists to
// document the pattern and to exercise the loader's config injection in tests.
//
// It mimics a hosted-sandbox vendor ("Daytona"-style): the Operator supplies
// one deploy-time credential block (an API token) plus non-secret config (a
// region). Core validates them at boot against the plugin-level schemas below
// and injects the single resolved block into BOTH contributions — the Sandbox
// backend and the management Tool set — proving one credential block is shared
// across every contribution and every tenant (deployment-wide).

// Plugin-level deploy-time schemas (separate from the per-Workspace Sandbox
// config/credentials the SandboxBackendContribution declares). `config` is
// non-secret shape; `credentials` is secret material shared across tenants.
export const examplePluginConfigSchema = z
  .object({ region: z.string().min(1).default("us") })
  .strict();
export const examplePluginCredentialsSchema = z
  .object({ apiToken: z.string().min(1) })
  .strict();

export type ExamplePluginConfig = z.infer<typeof examplePluginConfigSchema>;
export type ExamplePluginCredentials = z.infer<
  typeof examplePluginCredentialsSchema
>;

type ExamplePluginContext = PluginConfigContext<
  ExamplePluginConfig,
  ExamplePluginCredentials
>;

// A stub Sandbox backend that closes over the shared deploy-time credentials.
// A real adapter would use `apiToken` to authenticate every provisioning call
// to the vendor API; here it only records what it was handed so tests can
// assert the shared block reached it.
class ExampleSandboxBackend implements SandboxBackend {
  readonly apiToken: string;
  readonly region: string;

  constructor(plugin: ExamplePluginContext) {
    this.apiToken = plugin.credentials.apiToken;
    this.region = plugin.config.region;
  }

  shellExec() {
    return Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: 0,
      truncated: false,
      durationMs: 0,
    });
  }
  fsRead() {
    return Promise.resolve({ content: "", lineCount: 0, truncated: false });
  }
  fsWrite() {
    return Promise.resolve({ bytesWritten: 0 });
  }
  fsEdit() {
    return Promise.resolve({ replacements: 1 as const });
  }
  fsList() {
    return Promise.resolve({ entries: [], truncated: false });
  }
  destroy() {
    return Promise.resolve();
  }
}

// Contribution 1 — a Sandbox backend. Its create() ignores the per-Workspace
// config/credentials (an empty schema here) and instead authenticates with the
// deploy-time plugin credentials handed in as the third argument.
const exampleSandboxBackend: SandboxBackendContribution = {
  backend: "sandbox",
  name: "Example Cloud Sandbox",
  configSchema: z.object({}).strict(),
  credentialsSchema: z.object({}).strict(),
  create: (_config, _credentials, plugin) =>
    new ExampleSandboxBackend(plugin as ExamplePluginContext),
};

// Contribution 2 — a management Tool set. Its factory reads the SAME shared
// credential block (the second argument) to talk to the vendor's control API.
const exampleManagementToolSet: ToolSetContribution = {
  id: "management",
  name: "Example Management",
  category: "Sandbox",
  description: "Manage Example Cloud sandboxes for this workspace",
  tools: (_ctx, plugin) => {
    const { credentials, config } = plugin as ExamplePluginContext;
    return {
      listSandboxes: tool({
        description: "List sandboxes in the configured region",
        inputSchema: z.object({}),
        // A real tool would call the vendor API with `credentials.apiToken`.
        execute: () =>
          Promise.resolve(
            `Listing sandboxes in ${config.region} (token ${credentials.apiToken.slice(0, 3)}…)`,
          ),
      }),
    };
  },
};

export const plugin: PlatypusPlugin = {
  // A third-party manifest name is a url-safe slug (it becomes the
  // contribution-id prefix), distinct from the npm package specifier an Operator
  // would list in PLATYPUS_PLUGINS. See PlatypusPlugin.name in
  // @platypuschat/plugin-sdk.
  name: "example-cloud-sandbox",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  configSchema: examplePluginConfigSchema,
  credentialsSchema: examplePluginCredentialsSchema,
  contributes: {
    sandboxBackends: [exampleSandboxBackend],
    toolSets: [exampleManagementToolSet],
  },
};
