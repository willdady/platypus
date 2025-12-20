# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Platypus is a full-stack application for building and managing AI agents with tool support and multi-provider capabilities. It uses a monorepo structure with pnpm workspaces and Turborepo.

## Development Commands

### Initial Setup

```bash
pnpm install
cp apps/frontend/.example.env apps/frontend/.env
cp apps/backend/.example.env apps/backend/.env
```

### Running the Application

```bash
pnpm dev  # Starts both frontend and backend, and spins up local Postgres container
```

### Database Operations

```bash
pnpm drizzle-kit-push  # Apply schema changes to database (requires `pnpm dev` to be running)
```

### Other Commands

```bash
pnpm build   # Build all packages
pnpm format  # Format code with Prettier
```

## Architecture

### Monorepo Structure

The project is organized as a Turborepo monorepo with three main packages:

- **`apps/backend`**: Hono.js REST API server
- **`apps/frontend`**: Next.js frontend application
- **`packages/schemas`**: Shared Zod schemas used by both frontend and backend

### Backend Architecture (`apps/backend`)

**Framework**: Hono.js for HTTP routing and middleware

**Database**:

- Drizzle ORM with Postgres 17 (via Docker)
- Schema defined in `apps/backend/src/db/schema.ts`
- Local database automatically started by `pnpm dev` via `start_postgres.sh` script
- Database changes are applied using `pnpm drizzle-kit-push` (push-based, not migration files)

**Core Domain Models**:

- **Organisation** → **Workspace** → **Chat/Agent/MCP/Provider** (hierarchical relationship)
- `organisation`: Top-level tenant/org
- `workspace`: Scoped environment within an org
- `chat`: Chat sessions within a workspace
- `agent`: Configurable AI agents with system prompts, model selection, temperature, and tool assignments
- `mcp`: Model Context Protocol integrations
- `provider`: Custom AI provider configurations (OpenAI-compatible APIs)

**AI Implementation**:

- Uses AI SDK's `Experimental_Agent` class for agentic workflows
- Chat endpoint (`/chat`) accepts messages and streams responses using AI SDK
- Currently hardcoded to OpenRouter provider but extensible to custom providers
- Tools are registered in `src/tools/index.ts` and can be assigned to agents

**API Routes** (in `src/routes/`):

- `/chat`: Stream AI chat responses
- `/organisations`: CRUD for organisations
- `/workspaces`: CRUD for workspaces
- `/agents`: CRUD for agents with tool/model configuration
- `/tools`: List available tools
- `/models`: List available models
- `/mcps`: CRUD for MCP integrations
- `/providers`: CRUD for custom AI providers

**Entry Point**: `apps/backend/index.ts` starts the server and upserts default org/workspace on startup.

### Frontend Architecture (`apps/frontend`)

**Framework**: Next.js 16 with App Router

**Structure**:

- Uses App Router with `app/` directory
- Route structure: `/[orgId]/[workspaceId]/...` for multi-tenant routing
- Main chat interface in components: `chat.tsx`, `agent-form.tsx`, `provider-form.tsx`
- UI components in `components/ui/` (Radix UI + Tailwind CSS)
- AI-specific components in `components/ai-elements/`

**Styling**: Tailwind CSS v4 with design tokens in `app/globals.css`

**AI Integration**: Uses `@ai-sdk/react` for streaming chat UI components

### Shared Schemas (`packages/schemas`)

All domain models have Zod schemas defined in `packages/schemas/index.ts`:

- Full schemas (e.g., `agentSchema`)
- Create schemas (e.g., `agentCreateSchema`) - subset of fields for POST requests
- Update schemas (e.g., `agentUpdateSchema`) - subset of fields for PATCH requests

These schemas are imported by both frontend and backend to ensure type safety across the stack.

## Key Technical Details

### Database Schema Changes

1. Edit `apps/backend/src/db/schema.ts`
2. Ensure `pnpm dev` is running (database must be up)
3. Run `pnpm drizzle-kit-push` to apply changes

### Adding New API Endpoints

1. Create route file in `apps/backend/src/routes/`
2. Import and mount in `apps/backend/src/server.ts`
3. Define validation schemas in `packages/schemas/index.ts`
4. Use Hono's context to access the database: `c.get("db")`

### Adding New Tools for Agents

1. Define tool in `apps/backend/src/tools/` following existing patterns
2. Export from `apps/backend/src/tools/index.ts`
3. Tool IDs are stored in `agent.tools` JSONB array

### Environment Variables

- Backend requires `DATABASE_URL`, `ALLOWED_ORIGINS`, and `PORT`
- Frontend requires `BACKEND_URL`
- Default values work for local development after copying `.example.env` files

## Known Constraints

- Postgres 18 is NOT supported due to Drizzle ORM compatibility issues
- Currently only OpenRouter AI provider is fully implemented
- Custom providers use OpenAI-compatible API format
- When writing Typescript, format code matching the conventions used by Prettier.
- This project uses Bruno, the API Client, for working with and testing the API endpoints. The Bruno files are stored under `apps/backend/bruno`.
