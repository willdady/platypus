import { registerSandboxBackend } from "../index.ts";
import {
  DockerSandboxBackend,
  dockerSandboxConfigSchema,
  dockerSandboxCredentialsSchema,
} from "./docker.ts";
import { logger } from "../../logger.ts";

// Imported for side-effects at server bootstrap. Each adapter check its own
// enable flag before calling registerSandboxBackend so misconfigured deploys
// surface as "backend not registered" warnings at chat-turn time rather than
// hard boot failures.

if (process.env.PLATYPUS_SANDBOX_DOCKER_ENABLED === "true") {
  registerSandboxBackend({
    backend: "docker",
    name: "Local Docker",
    configSchema: dockerSandboxConfigSchema,
    credentialsSchema: dockerSandboxCredentialsSchema,
    create: (config, credentials) =>
      new DockerSandboxBackend(config, credentials),
  });
  logger.info("Docker sandbox backend registered");
}
