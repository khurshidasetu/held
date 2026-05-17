/**
 * Cartesia Ink-Whisper speech-to-text client.
 *
 * Cartesia exposes a WebSocket streaming STT API. We stream PCM through it
 * sequentially, send `{type:"finalize"}` to flush, then resolve as soon as
 * the server has nothing more to say — *not* when the connection eventually
 * closes on the server-side timeout, which is what made the previous
 * version take ~3 minutes for a 10-second clip.
 *
 * Endpoint: wss://api.cartesia.ai/stt/websocket
 * Auth:     X-API-Key + Cartesia-Version headers on the upgrade request.
 *
 * Output shape we return to the rest of the app:
 *   Array<{ text: string, start: number, end: number }>
 * (one entry per word, in chronological order)
 *
 * Note: Cartesia's exact event schema evolves; we narrow defensively and
 * skip any frame that doesn't carry word timings.
 */
import WebSocket from "ws";
import fs from "node:fs/promises";
import { env } from "./env";

export type Word = {
  text: string;
  start: number;
  end: number;
};

// Cartesia requires a date-stamped version header on every request — without
// it the WS handshake returns 400 ("Cartesia-Version header is required").
const CARTESIA_VERSION = "2026-03-01";

// After we send `finalize`, Cartesia's response cadence drops to "occasional
// final transcript chunks". The server holds the connection open for a long
// internal timeout (sometimes minutes). We instead wait this long for any
// new bytes after the finalize, and if nothing arrives, we have the full
// transcript — close the socket ourselves.
//
// 2 s is safely above any realistic gap between Cartesia's finalize-driven
// chunks (typically <500 ms) and well under the server's hold-open timeout.
const IDLE_FINISH_MS = 2000;

function buildSttUrl(): string {
  // Cartesia rejects auto/multi/wildcards for `language` but accepts the
  // parameter being omitted entirely — that's our default ("let the model
  // auto-handle code-switching"). Pin a specific BCP-47 tag via
  // CARTESIA_LANGUAGE only when every meeting is the same language.
  const params = new URLSearchParams({
    model: env.cartesia.model,
    encoding: "pcm_s16le",
    sample_rate: "16000",
  });
  const lang = env.cartesia.language;
  if (lang) params.set("language", lang);
  return `wss://api.cartesia.ai/stt/websocket?${params.toString()}`;
}

type CartesiaWord = {
  word?: string;
  text?: string;
  start?: number;
  end?: number;
  start_time?: number;
  end_time?: number;
};

type CartesiaMessage = {
  type?: string;
  is_final?: boolean;
  words?: CartesiaWord[];
  text?: string;
  start?: number;
  end?: number;
};

/**
 * Transcribe a 16 kHz mono PCM audio buffer. The caller is responsible for
 * resampling/converting whatever the browser uploaded (webm/mp4) into PCM
 * via ffmpeg before calling this.
 */
export function transcribePcm(pcm: Buffer): Promise<Word[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildSttUrl(), {
      headers: {
        "X-API-Key": env.cartesia.apiKey,
        "Cartesia-Version": CARTESIA_VERSION,
      },
    });

    const words: Word[] = [];
    let done = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let finalizeSent = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      try {
        ws.close();
      } catch {
        // socket may already be closing
      }
      if (err) reject(err);
      else resolve(words);
    };

    // Arm/reset the idle timer. Each incoming message resets the clock; when
    // it elapses with no traffic we know Cartesia has nothing more for us.
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), IDLE_FINISH_MS);
    };

    ws.on("open", () => {
      // Stream the PCM in ~100 ms chunks (16 kHz × 2 bytes × 0.1 s = 3200 B).
      const CHUNK = 3200;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        ws.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
      }
      ws.send(JSON.stringify({ type: "finalize" }));
      finalizeSent = true;
      // Arm idle timer the moment we ask Cartesia to flush. Any final-chunk
      // messages that arrive will reset it; otherwise we exit cleanly.
      armIdle();
    });

    ws.on("message", (data) => {
      let msg: CartesiaMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        // Non-JSON frames (binary, keep-alive) — refresh idle and move on.
        if (finalizeSent) armIdle();
        return;
      }

      if (msg.type === "error") {
        finish(new Error(`Cartesia error: ${JSON.stringify(msg)}`));
        return;
      }

      // Only collect finalized word lists; partial/interim frames get
      // superseded by the final transcript for that segment.
      if (msg.is_final !== false && Array.isArray(msg.words)) {
        for (const w of msg.words) {
          const text = (w.word ?? w.text ?? "").trim();
          const start = w.start ?? w.start_time;
          const end = w.end ?? w.end_time;
          if (!text || typeof start !== "number" || typeof end !== "number") {
            continue;
          }
          words.push({ text, start, end });
        }
      }

      // Cartesia uses a handful of terminal type strings depending on the
      // model and protocol version — be generous so we don't wait for an
      // idle-timeout when an explicit "done" exists.
      if (
        msg.type === "done" ||
        msg.type === "complete" ||
        msg.type === "flush_done" ||
        msg.type === "finalized"
      ) {
        finish();
        return;
      }

      if (finalizeSent) armIdle();
    });

    ws.on("error", (err) => finish(err));
    ws.on("close", () => finish());
  });
}

/**
 * Convenience wrapper: read a file at `path` (already 16 kHz mono PCM) and
 * transcribe it.
 */
export async function transcribePcmFile(path: string): Promise<Word[]> {
  const buf = await fs.readFile(path);
  return transcribePcm(buf);
}
