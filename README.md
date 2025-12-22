![](assets/platypus_256x256.png)

# Platypus

**A modern, multi-tenant platform for building and managing AI Agents.**

Platypus is an open-source, full-stack application designed to help you building AI agents. Built with a focus on extensibility and modern web standards, Platypus allows you to create agents that can reason, use tools, and interact with the world.

> 🚧 **Note:** Platypus is currently a Work In Progress. Features are being added rapidly. Authentication and Authorization are coming soon.

## ✨ Key Features

- **🏢 Multi-Tenancy:** Built-in support for Organisations and Workspaces to isolate data and manage teams.
- **🤖 Agentic Workflows:** Create sophisticated agents with custom system prompts, model configurations, and tool assignments.
- **🛠️ Extensible Tool System:** Register custom tools that agents can invoke intelligently to perform complex tasks.
- **🔌 MCP Support:** First-class support for the **Model Context Protocol** (MCP), allowing agents to securely connect to local and remote data sources.
- **⚡ Modern Tech Stack:** Built on the bleeding edge with **Next.js**, **Hono.js**, **Drizzle ORM**, and **Tailwind CSS**.
- **🌐 Provider Agnostic:** Powered by the Vercel AI SDK, supporting OpenAI, Anthropic, Google, Amazon Bedrock, and more via OpenRouter.

## 🏗️ Architecture

Platypus is a monorepo managed by [Turborepo](https://turbo.build/), ensuring a fast and efficient development workflow.

- **`apps/frontend`**: A responsive web interface built with Next.js, ShadCN, and Tailwind. It uses the AI SDK for real-time streaming responses.
- **`apps/backend`**: A high-performance REST API built with Hono.js running on Node.js. It handles agent logic, tool execution, and database interactions.
- **`packages/schemas`**: Shared Zod schemas used by both frontend and backend for end-to-end type safety.

## 🚀 Quick Start (Docker)

The fastest way to get Platypus running is using Docker Compose.

1.  **Install dependencies:**

    ```bash
    pnpm install
    ```

2.  **Build Docker images:**

    ```bash
    pnpm run build-docker
    ```

3.  **Start the application:**

    ```bash
    docker compose up -d
    ```

4.  **Navigate to:**
    ```bash
    http://localhost:3001
    ```

## 🛠️ Local Development

### Prerequisites

- **Docker** (for the local Postgres database)
- **Node.js v24+**
- **pnpm**
- An AI Provider API Key (e.g., OpenRouter, OpenAI)

### Setup

1.  **Install dependencies:**

    ```bash
    pnpm install
    ```

2.  **Configure Environment:**
    Create `.env` files for both apps:

    ```bash
    cp apps/frontend/.example.env apps/frontend/.env
    cp apps/backend/.example.env apps/backend/.env
    ```

3.  **Start Development Server:**
    This command starts the frontend, backend, and a local Postgres container.

    ```bash
    pnpm dev
    ```

4.  **Initialize Database:**
    Apply the schema to your local database (ensure `pnpm dev` is running first).
    ```bash
    pnpm drizzle-kit-push
    ```

## 🗺️ Roadmap

- [ ] Authentication & Authorization

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Platypus logo by [Thiings.co](https://www.thiings.co/things)
