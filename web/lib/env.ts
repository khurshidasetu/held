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

  // Speech-to-text provider.
  //   - "mock"           — placeholder transcript, no API key needed.
  //   - "cartesia"       — Cartesia Ink-Whisper over WebSocket. Fast +
  //                        cheap; weak on non-English / code-switching.
  //   - "gemini-audio"   — Gemini 2.5 Flash (Lite) via OpenRouter. Sends
  //                        the recording as a multimodal audio input and
  //                        asks the model to return segment-level
  //                        transcription with timestamps. Reuses
  //                        OPENROUTER_API_KEY — no separate STT key
  //                        required. Recommended for non-English /
  //                        code-switching meetings (Bangla + English).
  stt: {
    get provider(): "mock" | "cartesia" | "gemini-audio" {
      const v = (process.env.STT_PROVIDER || "mock").toLowerCase();
      if (v !== "mock" && v !== "cartesia" && v !== "gemini-audio") {
        throw new Error(
          `Invalid STT_PROVIDER: ${v} (expected "mock", "cartesia", or "gemini-audio")`
        );
      }
      return v;
    },
  },

  cartesia: {
    get apiKey() {
      return required("CARTESIA_API_KEY");
    },
    /**
     * STT model slug. `ink-whisper` (Cartesia's Whisper variant) is
     * multilingual and handles code-switching (e.g. Bangla mixed with
     * English) well out of the box.
     */
    get model() {
      return process.env.CARTESIA_MODEL || "ink-whisper";
    },
    /**
     * BCP-47 language tag (e.g. "en", "bn", "hi"). Cartesia rejects
     * "auto"/"multi"/wildcards, but accepts an *empty value* — which lets
     * Ink-Whisper auto-handle the language internally. That's ideal for
     * meetings where speakers code-switch (Bangla + English). Pin to a
     * specific tag only if you know every meeting will be a single language.
     */
    get language() {
      return process.env.CARTESIA_LANGUAGE ?? "";
    },
  },

  // LLM provider for meeting summaries.
  //   - "openrouter" — OpenAI-compatible proxy that routes to many models
  //     (default). One key, pick any model via OPENROUTER_MODEL.
  //   - "anthropic"  — direct to Anthropic's API.
  llm: {
    get provider(): "openrouter" | "anthropic" {
      const v = (process.env.LLM_PROVIDER || "openrouter").toLowerCase();
      if (v !== "openrouter" && v !== "anthropic") {
        throw new Error(
          `Invalid LLM_PROVIDER: ${v} (expected "openrouter" or "anthropic")`
        );
      }
      return v;
    },
  },

  openrouter: {
    get apiKey() {
      return required("OPENROUTER_API_KEY");
    },
    get model() {
      return process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
    },
    /** Optional — shown on https://openrouter.ai/rankings if set. */
    get referer() {
      return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    },
    get title() {
      return "Held";
    },
  },

  anthropic: {
    get apiKey() {
      return required("ANTHROPIC_API_KEY");
    },
    get model() {
      return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
    },
  },

  // STT-specific Gemini settings. Auth + base URL come from
  // env.openrouter.*; this group just lets us pick a different Gemini
  // variant for audio than the one used for summarisation if needed
  // (Flash Lite handles audio in our testing but if a future version
  // strips multimodal from Lite, override STT_GEMINI_MODEL to a full
  // Flash without touching the summary path).
  geminiAudio: {
    get model() {
      return process.env.STT_GEMINI_MODEL || process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash-lite";
    },
  },

  postmark: {
    // Postmark calls this the "Server API Token" — UUID format, per-server,
    // scoped to a single Postmark Server (the unit that holds sender
    // signatures + message streams).
    get token() {
      return required("POSTMARK_API_KEY");
    },
    // Verified Sender Signature email (or address on a verified domain).
    // Postmark rejects sends with an unverified From address.
    get sender() {
      return required("POSTMARK_SENDER");
    },
    get fromName() {
      return optional("POSTMARK_FROM_NAME") ?? "Held";
    },
  },

  get internalWorkerSecret() {
    return required("INTERNAL_WORKER_SECRET");
  },
};
