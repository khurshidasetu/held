/**
 * End-to-end smoke test for REAL diarization. Picks an existing recording
 * from web/storage, uploads it under a fresh key, signs an internal URL,
 * and hits the diarization service.
 *
 * Run: npx tsx scripts/test-diarization-real.ts [meetingId]
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local" });

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  uploadBuffer,
  getInternalPresignedGetUrl,
  audioKey,
} from "../lib/storage";

const meetingId =
  process.argv[2] ?? "867c4de4-7bb3-4107-b13b-7f8a71e5c563";

(async () => {
  const candidates = [
    join("storage", "meetings", meetingId, "audio.webm"),
    join("storage", "meetings", meetingId, "audio.mp4"),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error(`no audio for ${meetingId}`);

  const buf = readFileSync(file);
  const ext = file.endsWith("mp4") ? "mp4" : "webm";
  const testId = `realtest-${Date.now()}`;
  const key = audioKey(testId, ext);
  await uploadBuffer({
    key,
    body: buf,
    contentType: ext === "mp4" ? "audio/mp4" : "audio/webm",
  });

  const url = await getInternalPresignedGetUrl(key, 900);
  console.log(`→ source: ${file} (${buf.byteLength} bytes)`);
  console.log(`→ posting to diarization service…`);
  const t0 = Date.now();

  const res = await fetch(
    `${process.env.DIARIZATION_SERVICE_URL}/diarize`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.DIARIZATION_SERVICE_API_KEY!,
      },
      body: JSON.stringify({ audio_url: url }),
    }
  );

  const ms = Date.now() - t0;
  if (!res.ok) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    segments: { speaker: string; start: number; end: number }[];
  };

  console.log(`✓ ${body.segments.length} segments in ${ms} ms`);
  const speakers = new Set(body.segments.map((s) => s.speaker));
  console.log(`✓ ${speakers.size} distinct speaker(s): ${[...speakers].join(", ")}`);
  for (const s of body.segments.slice(0, 12)) {
    console.log(
      `    ${s.speaker.padEnd(12)}  ${s.start.toFixed(2).padStart(6)}s → ${s.end.toFixed(2).padStart(6)}s`
    );
  }
  if (body.segments.length > 12) {
    console.log(`    … ${body.segments.length - 12} more`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
