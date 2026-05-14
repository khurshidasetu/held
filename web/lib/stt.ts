/**
 * Speech-to-text orchestrator.
 *
 * Two providers:
 *   - "mock" (default for dev) — no API key needed. Probes the audio's true
 *     duration, then synthesizes a plausible meeting transcript distributed
 *     across that timeline. Lets the rest of the pipeline (merge + LLM
 *     summary) run end-to-end without a Cartesia account.
 *   - "cartesia" — real Ink-Whisper via WebSocket. Requires CARTESIA_API_KEY.
 *
 * Both return the same `Word[]` shape — `{ text, start, end }` per word — so
 * the merge step doesn't care which provider produced it.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env";
import { toPcm16kMono } from "./audio";
import { transcribePcm, type Word } from "./cartesia";

export type { Word } from "./cartesia";

/**
 * Top-level entry: given a path to any audio file ffmpeg can decode, return
 * word-level transcription. Picks the provider from env.
 */
export async function transcribeAudio(audioFilePath: string): Promise<Word[]> {
  // Both paths need PCM-form audio: cartesia streams it; mock measures it.
  // (PCM duration is exact: bytes / 2 / 16000 for 16-bit mono at 16 kHz.)
  const pcmFile = path.join(
    os.tmpdir(),
    `minutely-pcm-${randomUUID()}.s16le`
  );

  try {
    await toPcm16kMono(audioFilePath, pcmFile);
    const stat = await fs.stat(pcmFile);
    const durationSeconds = stat.size / 2 / 16000;

    if (env.stt.provider === "mock") {
      return mockTranscript(durationSeconds);
    }

    const pcm = await fs.readFile(pcmFile);
    return transcribePcm(pcm);
  } finally {
    await fs.rm(pcmFile, { force: true }).catch(() => {});
  }
}

// ── Mock provider ──────────────────────────────────────────────────────────

/**
 * Generate a fake meeting transcript with word-level timestamps spread evenly
 * across [0, durationSeconds]. The content is plausible enough that the LLM
 * can produce a coherent (if generic) summary — useful for demoing the full
 * pipeline before real Cartesia is wired up.
 */
function mockTranscript(durationSeconds: number): Word[] {
  if (durationSeconds <= 0) return [];

  // Generic project-meeting filler. Long enough to fill ~60-90 seconds of
  // audio; cycles for longer clips so we always have words to distribute.
  const SCRIPT = [
    "Hi everyone, thanks for joining today.",
    "Let's start by reviewing where we are on the launch plan.",
    "I want to confirm the timeline before we get into details.",
    "We need to ship by the end of next week.",
    "Are there any blockers we should discuss right now?",
    "The API integration is mostly done on my side.",
    "We still need to finalize the user onboarding flow.",
    "I can take that one and have a draft ready by Friday.",
    "Let's also align on the marketing announcement.",
    "We'll send the launch email on the day of release.",
    "Any other open items we need to cover today?",
    "Sounds good, let's wrap up here.",
    "Thanks everyone, I'll send a follow-up with the notes.",
  ];

  const words: string[] = [];
  while (true) {
    for (const sentence of SCRIPT) {
      words.push(...sentence.split(/\s+/));
      // Rough heuristic: ~2.5 words per second of speech.
      if (words.length >= durationSeconds * 2.5) break;
    }
    if (words.length >= durationSeconds * 2.5 || words.length === 0) break;
  }
  if (words.length === 0) return [];

  const wordDur = durationSeconds / words.length;
  return words.map((w, i) => ({
    text: w,
    start: i * wordDur,
    end: (i + 1) * wordDur,
  }));
}
