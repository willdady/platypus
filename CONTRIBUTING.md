# Contributing to Platypus

Thank you for your interest in contributing to Platypus! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and constructive in all interactions. We are committed to providing a welcoming and inclusive experience for everyone.

## Getting Started

1. **Fork the repository** and clone your fork locally.
2. **Set up your development environment** by following [Local Development](#local-development) below.
3. **Create a branch** from `main` for your changes (see [Branch Naming](#branch-naming) below).

> Running a Platypus instance (rather than developing it)? See the [Self-Hosting docs](https://docs.platypus.chat/self-hosting) instead.

## Local Development

This is the from-source workflow for contributors. (To simply run Platypus, use the [Docker quick start](README.md#-quick-start-docker).)

### Prerequisites

- **Docker** (for the local Postgres database with [pgvector](https://github.com/pgvector/pgvector))
- **Node.js v24+**
- **pnpm**
- An AI Provider API Key (e.g., OpenRouter, OpenAI)

### Setup

1. **Install dependencies:**

   ```bash
   pnpm install
   ```

2. **Configure environment** — create `.env` files for both apps:

   ```bash
   cp apps/frontend/.env.example apps/frontend/.env
   cp apps/backend/.env.example apps/backend/.env
   ```

   In `apps/backend/.env`, set at least:
   - `BETTER_AUTH_SECRET` — a secure random string (minimum 32 characters).
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD` — credentials for the initial admin user.

   See the comments in each `.env.example` and the [configuration reference](https://docs.platypus.chat/reference) for all options.

3. **Start the development server** (frontend, backend, and a local Postgres container):

   ```bash
   pnpm dev
   ```

4. **Initialize the database** (with `pnpm dev` running):

   ```bash
   pnpm drizzle-kit-push
   ```

5. **Sign in** at `http://localhost:3001` using the admin credentials from your `.env`.

### Accessing from other devices on your network

The dev setup is `localhost`-only by default. Session cookies are scoped to the host they were set on, so to reach Platypus from a phone or another machine you must use the **same** host (your LAN IP) consistently for both apps — mixing `localhost` and the IP in one browser silently breaks sign-in.

In `apps/frontend/.env` (replace `192.168.1.10` with your machine's LAN IP):

```env
BACKEND_URL=http://192.168.1.10:4001
INTERNAL_BACKEND_URL=http://localhost:4001
ALLOWED_DEV_ORIGINS=192.168.1.10
```

In `apps/backend/.env`:

```env
ALLOWED_ORIGINS=http://localhost:3001,http://192.168.1.10:3001
```

Then access the app via `http://192.168.1.10:3001` on every device, including your desktop.

## Branch Naming

All branches must use one of the following prefixes:

- `feature/` — New features or functionality
- `fix/` — Bug fixes
- `chore/` — Maintenance tasks (dependencies, formatting, etc.)

**Examples:**

```
feature/user-authentication
fix/memory-leak-in-chat
chore/update-dependencies
```

## Commit Messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Only the following commit types are allowed:

- `feat` — New features or functionality
- `fix` — Bug fixes
- `chore` — Maintenance tasks

**Format:** `<type>[optional scope]: <description>`

**Examples:**

```
feat: add user authentication
feat(backend): implement JWT token refresh
fix: resolve memory leak in chat component
fix(frontend): correct workspace navigation
chore: update dependencies
chore(tests): add missing test coverage
```

## Submitting a Pull Request

1. Ensure your code passes all tests (`pnpm test`) and is formatted (`pnpm format`).
2. Write clear, descriptive commit messages following the conventions above.
3. Open a pull request against the `main` branch.
4. Provide a clear description of the changes and the motivation behind them.
5. Link any related issues in your PR description.

## Project Structure

Platypus is a monorepo managed by [Turborepo](https://turbo.build/) with the following packages:

| Package            | Description                                   |
| ------------------ | --------------------------------------------- |
| `apps/frontend`    | Next.js web application                       |
| `apps/backend`     | Hono.js REST API server                       |
| `packages/schemas` | Shared Zod schemas for end-to-end type safety |

## Reporting Issues

If you find a bug or have a feature request, please [open an issue](https://github.com/willdady/platypus/issues) with a clear description and, if applicable, steps to reproduce.

## License

By contributing to Platypus, you agree that your contributions will be licensed under the [MIT License](LICENSE).
