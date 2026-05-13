import { defineConfig } from "drizzle-kit";

// drizzle-kit 0.30+ auto-loads .env, .env.local, .env.development for the
// CLI commands, so DATABASE_URL is expected to be populated from .env.local.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in."
  );
}

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
