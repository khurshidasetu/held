import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

// Lazy: Next 16 imports route modules in workers to gather config; we don't
// want a missing DATABASE_URL to break the build, only to fail at first query.
let _db: DrizzleDb | undefined;
function getDb(): DrizzleDb {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  _db = drizzle(neon(url), { schema });
  return _db;
}

// Proxy that defers to the real Drizzle instance on first use. Lets callers
// keep writing `import { db } from "@/db"; db.select()...` without changing.
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
}) as DrizzleDb;

export type Db = DrizzleDb;
export * from "./schema";
