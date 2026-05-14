import { config as loadDotenv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit doesn't auto-load .env.local — only Next.js does. Load it
// ourselves so `npm run db:push|generate|migrate` picks up DATABASE_URL
// from the same place the app reads it.
loadDotenv({ path: ".env.local" });
loadDotenv(); // also honour .env if present

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in."
  );
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
