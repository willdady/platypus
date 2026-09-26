<p align="center">
  <img src="assets/platypus_256x256.png" alt="Platypus" width="256" height="256" />
</p>

<h1 align="center">Platypus</h1>

<p align="center">
  <strong>Self-hosted AI Agents for your whole team — on your infrastructure, your models, around the clock.</strong>
</p>

<p align="center">
  <a href="https://github.com/willdady/platypus/releases/latest"><img src="https://img.shields.io/github/v/release/willdady/platypus" alt="Latest release" /></a>
  <a href="https://github.com/willdady/platypus/actions/workflows/ci.yml"><img src="https://github.com/willdady/platypus/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/@platypuschat/plugin-sdk"><img src="https://img.shields.io/npm/v/@platypuschat/plugin-sdk?label=plugin-sdk" alt="Plugin SDK on npm" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-6.0-blue.svg" alt="TypeScript" /></a>
</p>

Platypus is an open-source, full-stack application for building AI Agents that reason, use tools, and keep working when you aren't watching. You bring the models — hosted, proxied, or running on your own hardware — and Platypus gives you the Agents, the tools they call, the schedules they run on, and the multi-tenant boundaries that keep one team's work out of another's.

🌐 **Visit the website at [platypus.chat](https://platypus.chat).**

📚 **Full documentation lives at [docs.platypus.chat](https://docs.platypus.chat).**

![A Platypus Chat where an Agent edits a scheduled Trigger through tool calls](assets/00_screenshot.png)

## 💡 Why Platypus

- **Sovereignty.** Run against local or in-house models (Ollama, vLLM, Qwen, …) so internal data never leaves your infrastructure.
- **Always-on.** Agents run on triggers and keep working server-side after you close the tab — not on a laptop that has to stay awake.
- **Under one roof.** Agents, Boards, Dashboards, Sandboxes, MCP, Triggers, and Memory in one platform instead of a stack of stitched-together services.
- **Provider-agnostic.** Local _or_ frontier models, chosen per Agent, so you control the cost/capability trade-off.

## ✨ Key Features

- **🤖 Agents, Skills & Sub-Agents:** Build an Agent once — model, instructions, and tools — then give it reusable Skills it loads on demand and sub-agents it can delegate to.
- **🧰 Built-in Tool Sets:** Agents move Kanban cards, update Dashboards, post Notifications, manage Triggers, read the web, and even build other Agents and Skills.
- **🔌 MCP Support:** First-class **Model Context Protocol** support, so Agents connect securely to local and remote data sources.
- **🏖️ Sandbox:** Shell and filesystem access inside an isolated, per-workspace execution environment, with pluggable Docker and SSH reference backends.
- **🧠 Memory:** Facts and preferences are extracted from your conversations in the background and injected into future chats, so Agents remember you over time.
- **📋 Boards & Dashboards:** Drag-and-drop Kanban boards and widget-based dashboards, both readable and updatable by Agents through built-in tools.
- **⏰ Triggers:** Run Agents on a cron schedule, as a one-off, or in response to Workspace events like a card landing on a Board.
- **🔔 Notifications & Webhooks:** Agents post Notifications to the Workspace, and HMAC-signed webhooks push Board and Notification events to your own systems, with per-event filtering and automatic retries.
- **🏢 Multi-Tenancy:** Organizations and Workspaces isolate data and keep one team's work out of another's.
- **📐 Blueprints:** Package shared Agents, Skills, MCP servers, and Providers once, then stand up a new team's Workspace with them in one step.
- **🌐 Provider Agnostic:** Powered by the Vercel AI SDK — OpenAI, Anthropic, Google, Bedrock, and OpenRouter, plus Ollama, vLLM, and any OpenAI-compatible endpoint.
- **🧩 Plugins:** Add Tool sets, Sandbox backends, and web-search backends without forking, using the typed [`@platypuschat/plugin-sdk`](https://www.npmjs.com/package/@platypuschat/plugin-sdk).
- **⚖️ MIT Licensed:** Open source and free to use, on hardware you control.

![The Agents page of a Workspace, listing Agents with their tool sets, skills, and sub-agents](assets/01_screenshot.png)

See it all come together in the [daily board digest worked example](https://docs.platypus.chat/building-with-platypus/board-digest).

## 🚀 Quick Start (Docker)

```bash
git clone https://github.com/willdady/platypus.git
cd platypus
cp .env.example .env   # set BETTER_AUTH_SECRET and your admin credentials
docker compose up -d   # then open http://localhost:3000
```

> [!CAUTION]
> Change the default password after your first login!

Sign-in is email and password; there is no SSO/OIDC/SAML.

For configuration, providers, sandbox infrastructure, and production deployment, see the [Self-Hosting guide](https://docs.platypus.chat/self-hosting).

## 📚 Documentation

The docs site is the single source of truth for setup, concepts, and reference material:

- **[Getting Started](https://docs.platypus.chat/getting-started)** — quick start, first run, and the default admin account.
- **[Administering](https://docs.platypus.chat/administering)** — managing Workspaces and sharing resources across an Organization.
- **[Self-Hosting](https://docs.platypus.chat/self-hosting)** — Docker Compose, configuration & environment, providers & auth, and sandbox infrastructure.
- **[Concepts](https://docs.platypus.chat/concepts)** — the domain model: Organizations, Workspaces, Agents, Skills, MCP, Sandbox, and Memory.
- **[Building with Platypus](https://docs.platypus.chat/building-with-platypus)** — agents & sub-agents, skills, tool sets, MCP servers, triggers, boards, dashboards, notifications, and webhooks.
- **[Extending](https://docs.platypus.chat/extending)** — writing plugins: Tool sets, Sandbox backends, and web-search backends.
- **[Reference](https://docs.platypus.chat/reference)** — backend and frontend configuration reference.

Docs track the latest release; older versions are available by checking out the matching git tag.

## 🏗️ Architecture

Platypus is a monorepo managed by [Turborepo](https://turbo.build/):

- **`apps/frontend`**: A responsive web interface built with Next.js, ShadCN, and Tailwind. It uses the AI SDK for real-time streaming responses.
- **`apps/backend`**: A high-performance REST API built with Hono.js running on Node.js. It handles agent logic, tool execution, and database interactions.
- **`apps/docs`** / **`apps/website`**: The [docs](https://docs.platypus.chat) and [marketing](https://platypus.chat) sites.
- **`packages/schemas`**: Shared Zod schemas used by both frontend and backend for end-to-end type safety.
- **`packages/plugin-sdk`**: The published plugin contract, with **`packages/example-plugin`** as a reference implementation.

## 🗺️ Roadmap

Curious where Platypus is headed — and where it isn't? See [ROADMAP.md](ROADMAP.md) for
the project vision and the themes we're working towards. If you're planning a substantial
contribution, read it (especially the non-goals) and open an issue describing it first so
the effort lands well.

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on local development, branch naming, commit conventions, and how to submit a pull request.

**New here?** Check for [good first issues](https://github.com/willdady/platypus/contribute), or pick up a well-scoped item from the Roadmap — a new Sandbox backend is a great first plugin.

---

Platypus logo by [Thiings.co](https://www.thiings.co/things)
