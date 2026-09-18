import { admin } from "better-auth/plugins";

/**
 * The better-auth plugins this backend runs with, in their own module so the
 * Drizzle auth schema can be checked against them without importing `auth.ts`
 * — which opens a database connection at module load.
 *
 * A plugin contributes columns to the auth tables, and better-auth validates
 * that the Drizzle schema carries them all at startup. `auth-schema.test.ts`
 * asserts the same thing, so adding a plugin here fails the suite until
 * `db/auth-schema.ts` carries its fields.
 */
const adminPlugin = admin();

export const authPlugins = [adminPlugin] as [typeof adminPlugin];
