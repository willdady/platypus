![](assets/platypus_256x256.png)

# Platypus

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org/)
[![Hono](https://img.shields.io/badge/Hono-API-orange.svg)](https://hono.dev/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://www.docker.com/)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220.svg)](https://pnpm.io/)

**A modern, multi-tenant platform for building and managing AI Agents.**

Platypus is an open-source, full-stack application designed to help you build AI agents. Built with a focus on extensibility and modern web standards, Platypus allows you to create agents that can reason, use tools, and interact with the world.

📚 **Full documentation lives at [docs.platypus.chat](https://docs.platypus.chat).**

![](assets/00_screenshot.png)

## ✨ Key Features

- **🏢 Multi-Tenancy:** Built-in support for Organizations and Workspaces to isolate data and manage teams.
- **🤖 Agentic Workflows:** Create sophisticated agents with custom system prompts, model configurations, and tool assignments.
- **✨ Skills:** Create reusable instruction sets that agents can dynamically load on-demand to handle specialized tasks.
- **🧩 Sub-Agents:** Agents can delegate specialized tasks to other agents, enabling hierarchical multi-agent workflows with isolated contexts and result streaming.
- **📱 Responsive Design:** A fully responsive interface that works seamlessly across desktop, tablet, and mobile devices.
- **🔌 MCP Support:** First-class support for the **Model Context Protocol** (MCP), allowing agents to securely connect to local and remote data sources.
- **📐 Blueprints _(experimental)_:** Define a named, organization-scoped set of shared resources (Agents, Skills, MCPs, Providers) and apply it to a Workspace to attach them all in one step. Applying is additive and idempotent, and it's a snapshot — editing a Blueprint never disturbs Workspaces you've already provisioned from it.
- **🏖️ Sandbox _(experimental)_:** Give agents shell and filesystem access inside an isolated, per-workspace execution environment. Ships with a Docker reference backend (single-node / self-hosted only — see `compose.sandbox.yaml`); the adapter interface is pluggable so other backends can be contributed.
- **🧠 Memory:** Platypus automatically extracts facts and preferences from your conversations in the background and injects them into future chats, so agents remember things about you over time.
- **📋 Kanban Boards:** Organize work visually with drag-and-drop Kanban boards. Agents can create, move, and update cards autonomously via built-in Kanban tools.
- **📊 Dashboards _(experimental)_:** Build widget-based dashboards to surface agent data at a glance. Supports metric, text/markdown, image, weather, line chart, bar chart, and pie chart widgets with a drag-and-drop layout editor. Agents can update widget data autonomously via built-in dashboard tools.
- **🔔 Webhooks:** Receive real-time HTTP callbacks for notification events, with per-event filtering, custom headers, HMAC-SHA256 signing, and automatic retries.
- **⏰ Schedules:** Schedule agents to run automatically at specified times using cron expressions, with support for timezones and one-off executions.
- **⚡ Modern Tech Stack:** Built on the bleeding edge with **Next.js**, **Hono.js**, **Drizzle ORM**, **pgvector**, and **Tailwind CSS**.
- **🌐 Provider Agnostic:** Powered by the Vercel AI SDK, supporting OpenAI, Anthropic, Google, Amazon Bedrock, and OpenRouter.
- **⚖️ MIT Licensed:** Open source and free to use.

![](assets/01_screenshot.png)

## 🚀 Quick Start (Docker)

```bash
git clone https://github.com/willdady/platypus.git
cd platypus
cp .env.example .env   # set BETTER_AUTH_SECRET and your admin credentials
docker compose up -d   # then open http://localhost:3000
```

> [!CAUTION]
> Change the default password after your first login!

For configuration, providers, sandbox infrastructure, and production deployment, see the [Self-Hosting guide](https://docs.platypus.chat/self-hosting).

## 📚 Documentation

The docs site is the single source of truth for setup, concepts, and reference material:

- **[Getting Started](https://docs.platypus.chat/getting-started)** — quick start, first run, and the default admin account.
- **[Self-Hosting](https://docs.platypus.chat/self-hosting)** — Docker Compose, configuration & environment, providers & auth, and sandbox infrastructure.
- **[Concepts](https://docs.platypus.chat/concepts)** — the domain model: Organizations, Workspaces, Agents, Skills, MCP, Sandbox, and Memory.
- **[Building with Platypus](https://docs.platypus.chat/building-with-platypus)** — agents & sub-agents, skills, MCP servers, schedules, boards, and dashboards.
- **[Reference](https://docs.platypus.chat/reference)** — backend and frontend configuration reference.

Docs track the latest release; older versions are available by checking out the matching git tag.

## 🏗️ Architecture

Platypus is a monorepo managed by [Turborepo](https://turbo.build/):

- **`apps/frontend`**: A responsive web interface built with Next.js, ShadCN, and Tailwind. It uses the AI SDK for real-time streaming responses.
- **`apps/backend`**: A high-performance REST API built with Hono.js running on Node.js. It handles agent logic, tool execution, and database interactions.
- **`packages/schemas`**: Shared Zod schemas used by both frontend and backend for end-to-end type safety.

The [Extending guide](https://docs.platypus.chat/extending) covers contribution-facing extension points (sandbox backends, tool sets).

## 🗺️ Roadmap

Curious where Platypus is headed — and where it isn't? See [ROADMAP.md](ROADMAP.md) for
the project vision and the themes we're working towards. If you're planning a substantial
contribution, read it (especially the non-goals) and open a discussion first so the effort
lands well.

## 🤝 Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details on local development, branch naming, commit conventions, and how to submit a pull request.

---

Platypus logo by [Thiings.co](https://www.thiings.co/things)
