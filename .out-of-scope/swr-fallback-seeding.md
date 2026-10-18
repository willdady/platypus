# SWR Fallback Seeding

The frontend does not pass a server layout's read to SWR as seed data. When the Workspace layout reads the Workspace row on the server, the client still fetches that row itself.

## Why this is out of scope

On a hard load or refresh of a Workspace, seeding saves one request. On soft navigation within a Workspace, the client read is already served from the SWR cache, so seeding saves nothing.

Getting that one request back costs more than it is worth:

- **A nested `fallback` can't reach the read.** The root `SWRConfig` and the client read of the Workspace row both live in `AuthProvider`, which is mounted in the root layout, above the Workspace layout. Context only flows down, so a seed inside the Workspace layout never reaches that read.
- **Seeding the global cache is a side effect.** The other route is a client component that runs `mutate(key, body, { revalidate: false })`. Running it during render is a side effect in render. Running it in an effect races `AuthProvider`'s own fetch.
- **A seed alone doesn't stop the fetch.** SWR treats seeded data as stale and fetches it again one frame later. Stopping that means turning off revalidation for the read (`revalidateIfStale: false` or `revalidateOnMount: false`). The auth gate would then hold a Workspace row that can go stale for the whole session. For example, if the Owner changes the self-management flags in another tab, this tab never sees the change.
- **The Organization row has one server reader.** Only the Organization settings layout reads it, and only as a label, so there is almost nothing to seed.

## Prior requests

- #1576: "seed SWR from server layout reads" (split out of #1553)
