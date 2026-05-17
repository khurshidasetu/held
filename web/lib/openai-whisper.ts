/**
 * OpenAI Whisper STT client.
 *
 * Why this exists alongside lib/cartesia.ts:
 *
 * Cartesia Ink-Whisper is fast (WebSocket streaming, sub-second latency)
 * and cheap, but its auto-language-detect routinely mis-routes
 * non-English speech back through the English lexicon. Bangla recordings
 * come out as gibberish English. There's no clean way to tune around
 * this — it's a model-level limitation.
 *
 * OpenAI's Whisper (`whisper-1`) is the same Whisper architecture
 * Cartesia derived from, but the full multilingual checkpoint. It handles
 * code-switching natively (each frame gets a language ID, not the whole
 * recording), and `verbose_json` + `timestamp_granularities=["word"]`
 * gives us word-level timestamps — same `Word[]` shape we already use
 * downstream, so mergeTranscript needs no changes.
 *
 * Endpoint: https://api.openai.com/v1/audio/transcriptions
 * Auth:     Authorization: Bearer <OPENAI_API_KEY>
 * Cost:     $0.006 / minute of audio (as of last check; verify on OpenAI
 *           pricing if billing is a concern).
 *
 * Audio format: Whisper accepts mp3, mp4, mpeg, mpga, m4a, wav, webm.
 * Our recordings are webm (Chrome/Firefox/Android) or mp4 (iOS Safari),
 * both natively supported — no transcoding step needed.
 *
 * Size limit: 25 MB per request. Typical Held meetings (Opus-encoded
 * webm) are well under this for runs up to ~1 hour. Longer / lossless
 * meetings could exceed it; not handled here but documented inline so
 * a future chunker has a clear failure mode to look for.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import type { Word } from "./cartesia";

type WhisperVerboseResponse = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    text: string;
  }>;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
};

/**
 * Transcribe an audio file via OpenAI Whisper. Returns word-level
 * timestamps so mergeTranscript can align them with diarization
 * segments the same way it does for Cartesia output.
 *
 * Optional `languageHint` is a BCP-47 tag (e.g. "bn", "en"). Omit for
 * full auto-detect with per-frame language ID, which is what makes
 * code-switching work — DON'T pin a single language if the speakers
 * mix languages, or Whisper will force-translate the minority language
 * into the pinned one's phonemes.
 */
export async function transcribeWhisper(
  audioFilePath: string,
  languageHint?: string
): Promise<Word[]> {
  const buf = await fs.readFile(audioFilePath);
  const filename = path.basename(audioFilePath);
  const mime = guessMime(filename);

  const form = new FormData();
  // The Whisper API needs a filename + content type, otherwise it falls
  // back to "application/octet-stream" and 400s on the actual decode.
  // Wrapping the Buffer in a Blob with the right type avoids that.
  form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), filename);
  form.append("model", env.openai.model);
  form.append("response_format", "verbose_json");
  // timestamp_granularities is repeatable — passing both gives us
  // segment-level metadata AND word-level timestamps in one response.
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");
  if (languageHint) {
    form.append("language", languageHint);
  }

  const res = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openai.apiKey}`,
        // Don't set Content-Type — fetch will set it (with boundary)
        // automatically for FormData. Setting it manually breaks the
        // multipart parse on Whisper's side.
      },
      body: form,
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenAI Whisper ${res.status}: ${body.slice(0, 500)}`
    );
  }

  const data = (await res.json()) as WhisperVerboseResponse;

  // Primary path: word-level timestamps. This is what we want for
  // diarization alignment.
  if (Array.isArray(data.words) && data.words.length > 0) {
    return data.words.map((w) => ({
      text: w.word.trim(),
      start: w.start,
      end: w.end,
    }));
  }

  // Defensive fallback: if Whisper returned only segment-level timestamps
  // (e.g. an older model variant), spread each segment's words evenly
  // across its time range. Less accurate but still useful.
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    const words: Word[] = [];
    for (const seg of data.segments) {
      const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue;
      const dur = Math.max(0, seg.end - seg.start);
      const per = dur / tokens.length;
      for (let i = 0; i < tokens.length; i++) {
        words.push({
          text: tokens[i],
          start: seg.start + i * per,
          end: seg.start + (i + 1) * per,
        });
      }
    }
    return words;
  }

  // Last resort: just `text` with no timing. Synthesize a single
  // catch-all "word" covering the full duration so mergeTranscript
  // still attributes it to the first speaker rather than dropping it.
  if (typeof data.text === "string" && data.text.trim().length > 0) {
    return [
      {
        text: data.text.trim(),
        start: 0,
        end: typeof data.duration === "number" ? data.duration : 0,
      },
    ];
  }

  return [];
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".webm":
      return "audio/webm";
    case ".mp4":
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}
