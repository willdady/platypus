# Storage Backend for Chat File Attachments

## Context

Chat messages are stored as JSONB in Postgres. When users attach images/files, they're embedded as base64 data URLs directly in the message parts (`FileUIPart.url`). This bloats the database — a single image can add 1-2MB to a row. This feature extracts binary data into a pluggable storage backend (local disk or S3-compatible) and replaces inline data with references.

Existing chats with inline data URLs remain backwards compatible — the frontend renders both data URLs and HTTP URLs. No migration needed.

## Design

**On save:** Scan message `parts` for `FileUIPart` entries with `data:` URLs → decode base64 → store via storage backend → replace `url` with `storage://{key}`.

**On load:** Rewrite `storage://{key}` URLs to a serving URL. By default this points to the backend's `/files/{key}` endpoint. When `STORAGE_PUBLIC_URL` is set (e.g., an S3 bucket URL or CDN), URLs rewrite to `{STORAGE_PUBLIC_URL}/{key}` instead, allowing direct browser-to-storage fetching without proxying through the backend.

**Frontend is unchanged** — it already renders `<img src={url}>`.

## New Files

All under `apps/backend/src/storage/`:

| File | Purpose |
|---|---|
| `types.ts` | `StorageBackend` interface |
| `disk.ts` | Local filesystem implementation |
| `s3.ts` | S3-compatible implementation |
| `index.ts` | Factory + singleton |
| `utils.ts` | `extractFiles()` and `rewriteStorageUrls()` helpers |

Plus:
- `apps/backend/src/routes/files.ts` — file-serving endpoint (proxy mode)

## Storage Interface

```typescript
interface StorageBackend {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}
```

## Storage Key Format

```
{orgId}/{workspaceId}/{chatId}/{messageId}/{partIndex}-{hash8}.{ext}
```

`hash8` = first 8 chars of SHA-256 of the binary content. `ext` derived from media type.

## Implementation Steps

### 1. Storage interface and implementations

- **`storage/types.ts`**: Define `StorageBackend` interface
- **`storage/disk.ts`**: `DiskStorage` class
  - Uses `STORAGE_DISK_PATH` env var (default: `./data/files`)
  - Key maps to filesystem path; stores `.meta` JSON sidecar for content type
  - Creates directories recursively on `put`
- **`storage/s3.ts`**: `S3Storage` class
  - Uses `@aws-sdk/client-s3` — add as dependency
  - Env vars: `STORAGE_S3_BUCKET`, `STORAGE_S3_REGION`, `STORAGE_S3_ENDPOINT`, `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`
  - Content type stored as S3 object metadata
- **`storage/index.ts`**: Factory reads `STORAGE_BACKEND` env var (`disk` | `s3`, default `disk`), returns singleton

### 2. Extract/rewrite utilities (`storage/utils.ts`)

- **`extractFiles(messages, context)`**: Walks `parts`, finds `FileUIPart` with `data:` URLs, decodes, stores, replaces URL with `storage://{key}`. Returns modified messages. On storage failure, leaves the data URL as-is and logs error.
- **`rewriteStorageUrls(messages, baseUrl)`**: Replaces `storage://{key}` with `{baseUrl}/files/{key}`. If `STORAGE_PUBLIC_URL` is set, uses that as the base instead. Returns modified messages.

### 3. File-serving endpoint (`routes/files.ts`)

- `GET /files/*` — wildcard route to capture the full key
- Protected with `requireAuth`
- Authorization: extract `orgId`/`workspaceId` from key path segments, verify user has access
- Returns file with correct `Content-Type` and `Cache-Control: private, max-age=31536000, immutable`
- 404 if not found
- Mount in `server.ts`
- Note: When `STORAGE_PUBLIC_URL` is set, this endpoint is bypassed (browser fetches directly from storage). It still exists as a fallback.

### 4. Integrate into chat routes (`routes/chat.ts`)

**Save** — in `upsertChatRecord` (~line 386), before setting `dbValues.messages`:
```typescript
const processedMessages = await extractFiles(messages, { orgId, workspaceId, chatId: id });
```
Add `orgId` as a parameter to `upsertChatRecord` (currently not passed).

**Load** — in `GET /:chatId` handler (~line 517-532), before returning:
```typescript
record[0].messages = rewriteStorageUrls(record[0].messages, baseUrl);
```

**Delete** — in `DELETE /:chatId` handler (~line 770-793), before deleting from DB:
- Extract all `storage://` keys from the chat's messages
- Call `storage.delete()` for each (best-effort, don't fail the delete if cleanup fails)

### 5. Environment variables

Add to `apps/backend/.example.env`:
```
# Storage backend: "disk" (default) or "s3"
STORAGE_BACKEND=disk

# Disk storage path (when STORAGE_BACKEND=disk)
STORAGE_DISK_PATH=./data/files

# Optional: public URL for direct file access (bypasses /files proxy endpoint)
# e.g. https://mybucket.s3.amazonaws.com or a CDN URL
# STORAGE_PUBLIC_URL=

# S3 storage (when STORAGE_BACKEND=s3)
# STORAGE_S3_BUCKET=
# STORAGE_S3_REGION=
# STORAGE_S3_ENDPOINT=
# STORAGE_S3_ACCESS_KEY_ID=
# STORAGE_S3_SECRET_ACCESS_KEY=
```

### 6. Docker — add volume mount to Dockerfile

In `apps/backend/Dockerfile`, add to the runner stage:
```dockerfile
RUN mkdir -p /data/files && chown hono:nodejs /data/files
```

And document that users should mount a volume: `-v ./data:/data`

### 7. Update README

Add a "Storage" section to `README.md` explaining:
- Default disk storage and how it works
- How to configure S3-compatible storage
- `STORAGE_PUBLIC_URL` for direct serving
- Docker volume mount recommendation

### 8. Tests

- Unit tests for `extractFiles()` and `rewriteStorageUrls()` with mock data URLs
- Unit tests for `DiskStorage` using a temp directory
- Integration test for the `/files/*` endpoint

## Files to Modify

- `apps/backend/src/routes/chat.ts` — integrate extract on save, rewrite on load, cleanup on delete
- `apps/backend/src/server.ts` — mount `/files` route
- `apps/backend/.example.env` — new env vars
- `apps/backend/package.json` — add `@aws-sdk/client-s3` dependency
- `apps/backend/Dockerfile` — create /data/files directory
- `README.md` — document storage backend configuration

## Verification

1. Start dev server (`pnpm dev`)
2. Send a chat message with an image attachment
3. Verify the image is stored on disk at `./data/files/...`
4. Verify the DB record's messages contain `storage://` URLs (not data URLs)
5. Reload the chat — verify the image displays correctly (served via `/files/` endpoint)
6. Delete the chat — verify the file is removed from disk
7. Run tests: `pnpm --filter backend test`
