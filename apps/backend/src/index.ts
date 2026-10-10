import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle(process.env.DATABASE_URL!);

/** A transaction `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export { db };
