// Self-Hosting section order. Audience: Operator, plus the Org Admin tasks that
// bootstrap a usable installation. Ordered as the job runs: stand it up,
// configure it, connect a model, let people in, add a sandbox, harden it, keep it
// current. "upgrading" is a stable nav slot that accumulates per-version
// sections rather than being retitled each release.
const meta = {
  index: "Overview",
  "docker-compose": "Deploy with Docker Compose",
  configuration: "Configuration & environment",
  "providers-and-auth": "Providers & authentication",
  "users-and-access": "Users & access",
  sandbox: "Sandbox infrastructure",
  production: "Running in production",
  upgrading: "Upgrading",
};

export default meta;
