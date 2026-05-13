import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "./schema";

type DrizzleDb = MySql2Database<typeof schema>;

// Lazy: Next 16 imports route modules in workers to gather config; we don't
// want a missing DATABASE_URL to break the build, only to fail at first query.
let _db: DrizzleDb | undefined;
function getDb(): DrizzleDb {
  if (_db) return _db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = mysql.createPool({
    uri: url,
    // Generous defaults — meeting processing can take a while and we don't
    // want to drop the connection mid-pipeline. Override via env if needed.
    connectionLimit: Number(process.env.DATABASE_POOL_SIZE ?? 10),
    waitForConnections: true,
  });
  _db = drizzle(pool, { schema, mode: "default" });
  return _db;
}

// Proxy that defers to the real Drizzle instance on first use, so callers can
// still `import { db } from "@/db"; db.select()...`.
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
}) as DrizzleDb;

export type Db = DrizzleDb;
export * from "./schema";
