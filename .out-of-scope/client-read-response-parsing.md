# Client Read Response Parsing

The frontend does not run Zod over the response bodies of its reads. `fetcher` and `optionalFetcher` cast the JSON to the type the caller declares, and nothing checks the shape at runtime.

## Why this is out of scope

The REST API is not a public surface. Its only supported client is the frontend from the same release, and both sides take their types from `@platypus/schemas`. A response that doesn't match its type is a bug inside this repo, not untrusted input, and types and tests are where it gets caught.

Parsing at runtime would cost more than the drift it catches:

- **Wire schemas.** The schemas declare dates as `z.date()`, but JSON delivers strings. Every entity a read returns would need a wire variant, or the parse would have to coerce dates and change what `Serialized<T>` callers get.
- **Unknown keys.** A plain `z.object` silently drops fields it doesn't know. Making every schema strict instead fails the frontend on any field the backend adds.
- **Missing schemas.** Inline response shapes and local types would each need a new schema plus a list envelope.
- **Runtime cost.** Every poll and revalidation would run the parse.

## Prior requests

- #1574: "parse client reads through @platypus/schemas instead of casting"
