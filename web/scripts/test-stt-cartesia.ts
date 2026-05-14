/**
 * Smoke test: run transcribeAudio() against the active STT provider
 * (currently Cartesia per .env.local). Uses one of the existing recordings
 * already on disk so we don't burn a synthetic clip's quota.
 *
 * Run: npx tsx scripts/test-stt-cartesia.ts [meetingId]
 *      (defaults to a hard-coded meeting if no id is passed)
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });

import path from "node:path";
import { existsSync } from "node:fs";
import { transcribeAudio } from "../lib/stt";

const meetingId =
  process.argv[2] ?? "867c4de4-7bb3-4107-b13b-7f8a71e5c563";

(async () => {
  const candidates = [
    path.join("storage", "meetings", meetingId, "audio.webm"),
    path.join("storage", "meetings", meetingId, "audio.mp4"),
  ];
  const audioPath = candidates.find((p) => existsSync(p));
  if (!audioPath) {
    throw new Error(
      `No audio file found for meeting ${meetingId}. Tried: ${candidates.join(", ")}`
    );
  }
  console.log(`→ provider: ${process.env.STT_PROVIDER ?? "mock"}`);
  console.log(`→ file:     ${audioPath}`);

  const t0 = Date.now();
  const words = await transcribeAudio(audioPath);
  const ms = Date.now() - t0;
  console.log(`✓ got ${words.length} words in ${ms} ms`);

  if (words.length === 0) {
    console.log("  (no words — silence, or the provider returned nothing)");
    return;
  }

  // Render a preview: the first ~30 words with their timestamps.
  const preview = words.slice(0, 30);
  for (const w of preview) {
    console.log(
      `    ${w.start.toFixed(2).padStart(6)}s → ${w.end.toFixed(2).padStart(6)}s  ${w.text}`
    );
  }
  if (words.length > preview.length) {
    console.log(`    … ${words.length - preview.length} more`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
