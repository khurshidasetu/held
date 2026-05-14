/**
 * Cartesia Ink-Whisper speech-to-text client.
 *
 * Cartesia exposes a WebSocket streaming STT API. For our use case the meeting
 * audio is already a finished file by the time we transcribe (we record first,
 * then process), so we stream it through the socket sequentially and collect
 * the word-level events.
 *
 * Endpoint: wss://api.cartesia.ai/stt/websocket
 * Auth:     X-API-Key header on the upgrade request.
 *
 * Output shape we return to the rest of the app:
 *   Array<{ text: string, start: number, end: number }>
 * (one entry per word, in chronological order)
 *
 * Note: Cartesia's exact event schema evolves; we narrow defensively and skip
 * any frame that doesn't carry word timings.
 */
import WebSocket from "ws";
import fs from "node:fs/promises";
import { env } from "./env";

export type Word = {
  text: string;
  start: number;
  end: number;
};

const CARTESIA_STT_URL =
  "wss://api.cartesia.ai/stt/websocket?model=ink-whisper&language=en&encoding=pcm_s16le&sample_rate=16000";

// Cartesia requires a date-stamped version header on every request — without
// it the WS handshake returns 400 ("Cartesia-Version header is required").
// Latest at time of writing per their own error response.
const CARTESIA_VERSION = "2026-03-01";

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
 * via ffmpeg before calling this — see `transcribeFile`.
 */
export function transcribePcm(pcm: Buffer): Promise<Word[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(CARTESIA_STT_URL, {
      headers: {
        "X-API-Key": env.cartesia.apiKey,
        "Cartesia-Version": CARTESIA_VERSION,
      },
    });

    const words: Word[] = [];
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        // socket may already be closing
      }
      if (err) reject(err);
      else resolve(words);
    };

    ws.on("open", () => {
      // Stream the PCM in ~50ms chunks (16000 * 2 bytes * 0.05 = 1600 bytes).
      const CHUNK = 3200;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        ws.send(pcm.subarray(i, Math.min(i + CHUNK, pcm.length)));
      }
      // Signal end-of-stream.
      ws.send(JSON.stringify({ type: "finalize" }));
      ws.send(JSON.stringify({ type: "done" }));
    });

    ws.on("message", (data) => {
      let msg: CartesiaMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
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

      if (msg.type === "done" || msg.type === "complete") {
        finish();
      }
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
