/**
 * Gemini-via-OpenRouter audio transcription client.
 *
 * Why this exists alongside lib/cartesia.ts:
 *
 * Cartesia Ink-Whisper's auto-language-detect routes non-English speech
 * (e.g. Bangla) back through the English lexicon and produces gibberish.
 * Gemini 2.5 is a true multilingual multimodal model — it accepts audio
 * inputs directly and does per-frame language ID, which is what makes
 * code-switching transcription (Bangla + English in one sentence) work.
 *
 * We talk to it through OpenRouter so we reuse the existing team key and
 * billing setup — no new API account, no new env var. The same
 * provider.data_collection / allow_fallbacks routing block used in
 * lib/llm.ts is repeated here for consistency with the team's privacy
 * guardrail.
 *
 * Output shape: identical to Cartesia — Word[] with { text, start, end }.
 * Gemini returns segment-level timestamps; we spread tokens evenly inside
 * each segment so mergeTranscript can still align with diarization
 * segments speaker-by-speaker. The granularity is coarser than Whisper's
 * true word timing, but for our merge step (which assigns a word to the
 * speaker whose segment overlaps its midpoint) it's accurate enough.
 *
 * Audio format: Gemini accepts mp3, mp4, wav, flac, webm natively. Held
 * records webm (Chrome/Firefox/Android) or mp4 (iOS Safari) — both are
 * passed through as-is, base64 encoded into the request.
 *
 * Known constraint: this rides on the team's OpenRouter pipe, so the same
 * privacy / guardrail block that affects /summarise also affects /stt
 * here. When the dashboard side is cleared, both unlock together.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { env } from "./env";
import type { Word } from "./cartesia";

const SegmentsSchema = z.object({
  segments: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().min(0),
        text: z.string(),
      })
    )
    .default([]),
});

const SYSTEM_PROMPT = `You are a verbatim speech-to-text transcriber.

Listen to the user's audio and produce an EXACT transcript of what is said.

Rules:
- Transcribe ONLY what you hear. Do NOT translate, summarise, or paraphrase.
- If the speaker uses multiple languages (e.g. Bangla + English code-switching),
  keep EACH language in its OWN native script. Bangla stays in Bangla script.
  English stays in Latin script. NEVER transliterate one language into another's
  script.
- Preserve disfluencies you can clearly hear (umm, uh, repeated words).
- If the audio is silent or unintelligible for a stretch, just skip it — do
  not invent words.

Output format: a JSON object with this exact shape, NOTHING else:

  {
    "segments": [
      { "start": <seconds>, "end": <seconds>, "text": "..." },
      ...
    ]
  }

- Each segment is a single utterance / breath group (~3-15 seconds).
- "start" and "end" are seconds from the very beginning of the audio.
- No prose before or after. No markdown. No code fences. Pure JSON.`;

/**
 * Transcribe an audio file via Gemini 2.5 (through OpenRouter). Returns
 * Word[] with timestamps spread evenly across each Gemini-reported
 * segment.
 *
 * Throws on HTTP failure or unparseable response — the caller (the
 * /process route) maps that into the meeting's status=failed flow.
 */
export async function transcribeGeminiAudio(
  audioFilePath: string
): Promise<Word[]> {
  const buf = await fs.readFile(audioFilePath);
  const base64 = buf.toString("base64");
  const filename = path.basename(audioFilePath);
  const format = formatFromFilename(filename);

  const body = {
    model: env.geminiAudio.model,
    // Audio transcripts can be long for hour-plus meetings — give the
    // model enough headroom. Token cost is per-output, so this is a
    // ceiling not a fixed cost.
    max_tokens: 16000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          // OpenAI-compatible audio block — OpenRouter normalises this
          // to whichever upstream format the chosen provider expects
          // (Gemini's `inlineData` part with mimeType + data, in this
          // case).
          {
            type: "input_audio",
            input_audio: { data: base64, format },
          },
          {
            type: "text",
            text: "Transcribe this audio. Return the JSON object.",
          },
        ],
      },
    ],
    response_format: { type: "json_object" },
    // Same routing block as the summarise call — keeps zero-log
    // providers in scope and lets OpenRouter fall back through Vertex
    // / AI Studio variants if the first endpoint is filtered.
    provider: {
      data_collection: "deny",
      allow_fallbacks: true,
    },
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openrouter.apiKey}`,
      "HTTP-Referer": env.openrouter.referer,
      "X-Title": env.openrouter.title,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Gemini audio ${res.status}: ${text.slice(0, 500)}`
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`Gemini audio error: ${data.error.message ?? "unknown"}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Gemini audio returned no text content");
  }

  let json: unknown;
  try {
    json = JSON.parse(stripCodeFences(text));
  } catch (err) {
    throw new Error(
      `Gemini transcript was not valid JSON: ${
        (err as Error).message
      }\n---\n${text.slice(0, 500)}`
    );
  }

  const parsed = SegmentsSchema.parse(json);

  return segmentsToWords(parsed.segments);
}

/**
 * Spread each segment's text across its [start, end] interval, one word
 * at a time, evenly. mergeTranscript only needs word timestamps that
 * fall within speaker segments — perfect per-word accuracy isn't
 * required, just monotonicity and rough placement.
 */
function segmentsToWords(
  segments: { start: number; end: number; text: string }[]
): Word[] {
  const out: Word[] = [];
  for (const seg of segments) {
    const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const dur = Math.max(0, seg.end - seg.start);
    if (dur === 0) {
      // Degenerate segment (model emitted equal start/end). Drop the
      // tokens at start with zero width — mergeTranscript snaps within
      // a small radius so they'll still get attributed.
      for (const t of tokens) {
        out.push({ text: t, start: seg.start, end: seg.start });
      }
      continue;
    }
    const per = dur / tokens.length;
    for (let i = 0; i < tokens.length; i++) {
      out.push({
        text: tokens[i],
        start: seg.start + i * per,
        end: seg.start + (i + 1) * per,
      });
    }
  }
  return out;
}

function formatFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".webm":
      return "webm";
    case ".mp4":
    case ".m4a":
      return "mp4";
    case ".mp3":
      return "mp3";
    case ".wav":
      return "wav";
    case ".flac":
      return "flac";
    case ".ogg":
      return "ogg";
    default:
      // Gemini's wrapper tends to accept "webm" as a default for browser
      // recordings; better than a generic octet that may be rejected.
      return "webm";
  }
}

function stripCodeFences(s: string): string {
  // Defensive: even with response_format=json_object some routes still
  // wrap in ```json fences.
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) return m[1].trim();
  return s.trim();
}
