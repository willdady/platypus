# Agent Kit

## Technology

### Backend

- Hono.js
- Drizzle ORM
- Postgres 17
- AI SDK

### Frontend

- Next.js
- AI SDK

## Development

### Prerequisites

The following software is required:

- Docker
- Node.js v24+
- pnpm

In addition to this you MUST have access to an AI provider.
Refer to the following [Setup](/#Setup) section for how to configure your provider credentials.

### Setup

Install dependencies.

```bash
pnpm install
```

You MUST create a `.env` in both the frontend and backend applications.
This should be done by copying each example file like so:

```bash
cp apps/frontend/.example.env apps/frontend/.env
cp apps/backend/.example.env apps/backend/.env
```

### Start dev environment.

```bash
pnpm dev
```

### Push database changes

Database tables are defined in `apps/backend/src/db/schema.ts`.
After making database changes apply them to the local database with the below command.
Note you MUST already have `turbo dev` running.

```bash
pnpm drizzle-kit-push
```

## Known issues

Currently, Postgres 18 is not supported due to [this issue](https://github.com/drizzle-team/drizzle-orm/issues/4944) with Drizzle ORM.
