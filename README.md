![](assets/platypus_256x256.png)

# Platypus

**A modern, multi-tenant platform for building and managing AI Agents.**

Platypus is an open-source, full-stack application designed to help you build AI agents. Built with a focus on extensibility and modern web standards, Platypus allows you to create agents that can reason, use tools, and interact with the world.

> [!NOTE]
> Platypus is currently a Work In Progress. Features are being added rapidly.

![](assets/00_screenshot.png)

## ✨ Key Features

- **🏢 Multi-Tenancy:** Built-in support for Organizations and Workspaces to isolate data and manage teams.
- **🤖 Agentic Workflows:** Create sophisticated agents with custom system prompts, model configurations, and tool assignments.
- **🛠️ Extensible Tool System:** Register custom tools that agents can invoke intelligently to perform complex tasks.
- **✨ Skills:** Create reusable instruction sets that agents can dynamically load on-demand to handle specialized tasks.
- **🧩 Sub-Agents (Experimental):** Agents can delegate specialized tasks to other agents, enabling hierarchical multi-agent workflows with isolated contexts and result streaming.
- **🔌 MCP Support:** First-class support for the **Model Context Protocol** (MCP), allowing agents to securely connect to local and remote data sources.
- **🧠 Memory:** Platypus automatically extracts facts and preferences from your conversations in the background and injects them into future chats, so agents remember things about you over time.
- **⚡ Modern Tech Stack:** Built on the bleeding edge with **Next.js**, **Hono.js**, **Drizzle ORM**, and **Tailwind CSS**.
- **🌐 Provider Agnostic:** Powered by the Vercel AI SDK, supporting OpenAI, Anthropic, Google, Amazon Bedrock, and OpenRouter.
- **⚖️ MIT Licensed:** Open source and free to use.

## 🏗️ Architecture

Platypus is a monorepo managed by [Turborepo](https://turbo.build/), ensuring a fast and efficient development workflow.

- **`apps/frontend`**: A responsive web interface built with Next.js, ShadCN, and Tailwind. It uses the AI SDK for real-time streaming responses.
- **`apps/backend`**: A high-performance REST API built with Hono.js running on Node.js. It handles agent logic, tool execution, and database interactions.
- **`packages/schemas`**: Shared Zod schemas used by both frontend and backend for end-to-end type safety.

## 🚀 Quick Start (Docker)

The fastest way to get Platypus running is using Docker Compose.

1.  **Configure environment:**

    Clone the repository, create a `compose.override.yaml` file (or edit `compose.yaml` directly) and set the following environment variables:
    - `BETTER_AUTH_SECRET`: A secure random string (minimum 32 characters).
    - `ADMIN_EMAIL`: The email address for the initial admin user.
    - `ADMIN_PASSWORD`: A secure password for the initial admin user.
    - `TIMEZONE` (optional): IANA timezone name for e.g., "America/New_York", "Europe/London". Defaults to UTC.
    - `MEMORY_EXTRACTION_INTERVAL_MS` (optional): How often (in milliseconds) the background memory extraction job runs. Defaults to `300000` (5 minutes).

    ```yaml
    services:
      backend:
        environment:
          BETTER_AUTH_SECRET: "your-secure-random-string-here"
          ADMIN_EMAIL: "admin@example.com"
          ADMIN_PASSWORD: "your-secure-password-here"
          TIMEZONE: "UTC"
    ```

2.  **Start the application:**

    ```bash
    docker compose up -d
    ```

3.  **Sign in:**

    Navigate to `http://localhost:3000` and sign in with the default credentials configured via the `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables.

> [!CAUTION]
> Change the default password after your first login!

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

    Edit `apps/backend/.env` and set the following environment variables:
    - `BETTER_AUTH_SECRET`: A secure random string (minimum 32 characters).
    - `ADMIN_EMAIL`: The email address for the initial admin user.
    - `ADMIN_PASSWORD`: A secure password for the initial admin user.
    - `TIMEZONE` (optional): IANA timezone name for e.g., "America/New_York", "Europe/London". Defaults to UTC.

    ```env
    BETTER_AUTH_SECRET: "your-secure-random-string-here"
    ADMIN_EMAIL: "admin@example.com"
    ADMIN_PASSWORD: "your-secure-password-here"
    TIMEZONE: "UTC"
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

5.  **Sign in:**
    Navigate to `http://localhost:3001` and sign in with the default credentials configured in your `.env` file (`ADMIN_EMAIL` and `ADMIN_PASSWORD`).

> [!CAUTION]
> Change the default password after your first login!

## 📦 Storage

Platypus stores file attachments (images, documents, etc.) separately from chat messages to keep the database efficient. When users attach files to messages, the binary data is extracted and stored in a pluggable storage backend, with only a reference stored in the database.

The following environment variables are configured in the **backend** service.

### Disk Storage (Default)

By default, files are stored on the local filesystem at `./data/files`. This works well for single-server deployments and local development.

```yaml
services:
  backend:
    environment:
      STORAGE_BACKEND: disk
      STORAGE_DISK_PATH: /data/files
    volumes:
      - ./data:/data
```

### S3-Compatible Storage

For production deployments, you can use any S3-compatible service (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, etc.):

```yaml
services:
  backend:
    environment:
      STORAGE_BACKEND: s3
      STORAGE_S3_BUCKET: my-bucket
      STORAGE_S3_REGION: us-east-1
      STORAGE_S3_ENDPOINT: https://s3.amazonaws.com
      STORAGE_S3_ACCESS_KEY_ID: your-access-key
      STORAGE_S3_SECRET_ACCESS_KEY: your-secret-key
```

### Direct File Access

For better performance with cloud storage, you can configure a public URL to serve files directly from your storage provider instead of proxying through the backend:

```yaml
services:
  backend:
    environment:
      STORAGE_PUBLIC_URL: https://my-bucket.s3.amazonaws.com
```

This allows browsers to fetch files directly from S3 (or via CDN) instead of going through the backend `/files` endpoint.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

Platypus logo by [Thiings.co](https://www.thiings.co/things)
