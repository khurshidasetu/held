/**
 * Centralized env-var access with runtime assertions.
 *
 * Accesses are *lazy* (via getters) for two reasons:
 *
 *  1. Next.js 16 collects page data in worker processes that import every
 *     route module to read its segment config. If env access were eager, any
 *     missing var would break the build even though the value isn't used.
 *  2. It keeps the failure mode tight — the error you see names the exact
 *     property you tried to use.
 *
 * Client code must NOT import this module.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

import path from "node:path";

export type StorageDriver = "local" | "s3";

function resolveLocalDir(): string {
  const raw = process.env.LOCAL_STORAGE_DIR || "./storage";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export const env = {
  get appUrl() {
    return required("NEXT_PUBLIC_APP_URL");
  },

  get databaseUrl() {
    return required("DATABASE_URL");
  },

  storage: {
    /** "local" by default — easier dev. Set STORAGE_DRIVER=s3 to use AWS. */
    get driver(): StorageDriver {
      const v = (process.env.STORAGE_DRIVER || "local").toLowerCase();
      if (v !== "local" && v !== "s3") {
        throw new Error(`Invalid STORAGE_DRIVER: ${v} (expected "local" or "s3")`);
      }
      return v;
    },
    get localDir(): string {
      return resolveLocalDir();
    },
    /**
     * Base URL the *browser* uses to fetch local files (speaker samples in
     * the popup, etc.). Defaults to NEXT_PUBLIC_APP_URL.
     */
    get localBaseUrl(): string {
      return process.env.LOCAL_STORAGE_BASE_URL || required("NEXT_PUBLIC_APP_URL");
    },
    /**
     * Base URL the diarization service uses to fetch local files. Defaults
     * to localBaseUrl, but when the diarization service runs in Docker on
     * the same machine, set this to http://host.docker.internal:3000 so the
     * container can reach the Next.js dev server on the host.
     */
    get internalBaseUrl(): string {
      return (
        process.env.INTERNAL_STORAGE_BASE_URL ||
        process.env.LOCAL_STORAGE_BASE_URL ||
        required("NEXT_PUBLIC_APP_URL")
      );
    },
    /**
     * HMAC secret for signing local file URLs. Falls back to the internal
     * worker secret so users don't have to set yet another env var; both
     * are server-only random strings.
     */
    get localSignSecret(): string {
      return (
        process.env.LOCAL_STORAGE_SIGN_SECRET ||
        required("INTERNAL_WORKER_SECRET")
      );
    },
  },

  aws: {
    // These are only accessed when STORAGE_DRIVER === "s3". With the local
    // driver active, missing AWS vars never trigger a throw.
    get region() {
      return required("AWS_REGION");
    },
    get bucket() {
      return required("AWS_S3_BUCKET");
    },
    get accessKeyId() {
      return required("AWS_ACCESS_KEY_ID");
    },
    get secretAccessKey() {
      return required("AWS_SECRET_ACCESS_KEY");
    },
  },

  diarization: {
    get url() {
      return required("DIARIZATION_SERVICE_URL");
    },
    get apiKey() {
      return required("DIARIZATION_SERVICE_API_KEY");
    },
  },

  cartesia: {
    get apiKey() {
      return required("CARTESIA_API_KEY");
    },
  },

  anthropic: {
    get apiKey() {
      return required("ANTHROPIC_API_KEY");
    },
  },

  postmark: {
    get token() {
      return required("POSTMARK_SERVER_TOKEN");
    },
    get fromEmail() {
      return required("POSTMARK_FROM_EMAIL");
    },
    get fromName() {
      return optional("POSTMARK_FROM_NAME") ?? "Minutely";
    },
  },

  get internalWorkerSecret() {
    return required("INTERNAL_WORKER_SECRET");
  },
};
