/**
 * End-to-end smoke test:
 *   1. Generate a small WAV file (sine tone, 20s).
 *   2. Upload it via the storage module under a fake meeting id.
 *   3. Build an internal signed URL (host.docker.internal:3000).
 *   4. POST /diarize on the diarization container.
 *   5. Print the segments.
 *
 * Run with: npx tsx scripts/test-diarization.ts
 */
import {
  uploadBuffer,
  getInternalPresignedGetUrl,
  audioKey,
} from "../lib/storage";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

const DIARIZATION_URL = process.env.DIARIZATION_SERVICE_URL ?? "http://localhost:8000";
const DIARIZATION_KEY = process.env.DIARIZATION_SERVICE_API_KEY!;

function makeWav(durationSeconds: number, sampleRate = 16000): Buffer {
  const numSamples = durationSeconds * sampleRate;
  const dataSize = numSamples * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    // 440 Hz sine — quiet, just enough that ffprobe sees real audio.
    const v = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.1 * 32767;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  return Buffer.concat([header, data]);
}

async function main() {
  const meetingId = `smoke-${Date.now()}`;
  const key = audioKey(meetingId, "wav");
  const wav = makeWav(20);

  console.log(`→ uploading 20s sine WAV (${wav.byteLength} bytes) as`, key);
  await uploadBuffer({ key, body: wav, contentType: "audio/wav" });

  const url = await getInternalPresignedGetUrl(key, 600);
  console.log(`→ internal URL:`, url);

  console.log(`→ POST ${DIARIZATION_URL}/diarize`);
  const res = await fetch(`${DIARIZATION_URL}/diarize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": DIARIZATION_KEY,
    },
    body: JSON.stringify({ audio_url: url }),
  });
  if (!res.ok) {
    throw new Error(`Diarize failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { segments: { speaker: string; start: number; end: number }[] };
  console.log(`✓ got ${body.segments.length} segments:`);
  for (const s of body.segments) {
    console.log(`    ${s.speaker.padEnd(11)}  ${s.start.toFixed(2).padStart(6)}s → ${s.end.toFixed(2).padStart(6)}s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
