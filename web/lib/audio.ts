/**
 * Audio transcoding helpers built on fluent-ffmpeg.
 *
 * Browsers upload either WebM/Opus (Chrome, Firefox, Android) or MP4/AAC
 * (Safari, iOS). Cartesia's Ink-Whisper streaming endpoint expects
 * 16 kHz, mono, 16-bit signed little-endian PCM. So we transcode once
 * server-side before streaming through the WebSocket.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Download `url` to a temp file and return the local path. Caller owns cleanup.
 */
export async function downloadToTemp(
  url: string,
  filename = `audio-${randomUUID()}`
): Promise<{ filePath: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "held-audio-"));
  const filePath = path.join(dir, filename);
  const res = await fetch(url);
  if (!res.ok) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to download audio: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
  return { filePath, dir };
}

/**
 * Transcode `inFile` (any ffmpeg-readable container) into a raw 16 kHz mono
 * 16-bit signed little-endian PCM file at `outFile`.
 */
export function toPcm16kMono(inFile: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec("pcm_s16le")
      .format("s16le")
      .on("error", reject)
      .on("end", () => resolve())
      .save(outFile);
  });
}

/**
 * Probe the duration in seconds (rounded to integer).
 */
export function probeDurationSeconds(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      const d = data?.format?.duration;
      if (typeof d !== "number" || Number.isNaN(d)) {
        return reject(new Error("Could not probe duration"));
      }
      resolve(Math.round(d));
    });
  });
}
