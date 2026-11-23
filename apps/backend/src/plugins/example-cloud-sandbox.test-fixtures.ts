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

const examplePluginConfigSchema = z
  .object({ region: z.string().min(1).default("us") })
  .strict();
const examplePluginCredentialsSchema = z
  .object({ apiToken: z.string().min(1) })
  .strict();

type ExampleConfig = z.infer<typeof examplePluginConfigSchema>;
type ExampleCredentials = z.infer<typeof examplePluginCredentialsSchema>;
type ExamplePluginContext = PluginConfigContext<
  ExampleConfig,
  ExampleCredentials
>;

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

const exampleSandboxBackend: SandboxBackendContribution<
  unknown,
  unknown,
  ExampleConfig,
  ExampleCredentials
> = {
  backend: "sandbox",
  name: "Example Cloud Sandbox",
  configSchema: z.object({}).strict(),
  credentialsSchema: z.object({}).strict(),
  create: (_config, _credentials, plugin) => new ExampleSandboxBackend(plugin),
};

const exampleManagementToolSet: ToolSetContribution<
  ExampleConfig,
  ExampleCredentials
> = {
  id: "management",
  name: "Example Management",
  category: "Sandbox",
  description: "Manage Example Cloud sandboxes for this workspace",
  tools: (_ctx, plugin) => {
    const { credentials, config } = plugin;
    return {
      listSandboxes: tool({
        description: "List sandboxes in the configured region",
        inputSchema: z.object({}),
        execute: () =>
          Promise.resolve(
            `Listing sandboxes in ${config.region} (token ${credentials.apiToken.slice(0, 3)}…)`,
          ),
      }),
    };
  },
};

export const plugin: PlatypusPlugin<ExampleConfig, ExampleCredentials> = {
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
