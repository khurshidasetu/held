/**
 * Repro for the "Could not probe audio duration" issue.
 *
 * Generates a WebM/Opus file like MediaRecorder would, uploads it, and posts
 * to /diarize. With the three-strategy ffprobe fallback, this should succeed.
 *
 * Run: npx tsx scripts/test-webm-diarization.ts
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  uploadBuffer,
  getInternalPresignedGetUrl,
  audioKey,
} from "../lib/storage";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

const DIARIZATION_URL = process.env.DIARIZATION_SERVICE_URL ?? "http://localhost:8000";
const DIARIZATION_KEY = process.env.DIARIZATION_SERVICE_API_KEY!;

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "held-webm-"));
  const outFile = join(dir, "test.webm");

  console.log(`→ encoding 15s WebM/Opus (no container-level duration)…`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegInstaller.path, [
      "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=15",
      "-c:a", "libopus",
      "-b:a", "32k",
      "-fflags", "+bitexact",
      "-f", "webm",
      outFile,
    ]);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))
    );
    p.stderr.on("data", () => {});
  });

  const buf = readFileSync(outFile);
  console.log(`→ uploaded ${buf.byteLength} bytes`);

  const meetingId = `webm-${Date.now()}`;
  const key = audioKey(meetingId, "webm");
  await uploadBuffer({ key, body: buf, contentType: "audio/webm" });

  const url = await getInternalPresignedGetUrl(key, 600);
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
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    segments: { speaker: string; start: number; end: number }[];
  };
  console.log(`✓ ${body.segments.length} segments returned:`);
  for (const s of body.segments) {
    console.log(`    ${s.speaker.padEnd(11)}  ${s.start.toFixed(2).padStart(6)}s → ${s.end.toFixed(2).padStart(6)}s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
