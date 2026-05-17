/**
 * Server-side utility: from a diarized audio file, extract a short MP3 sample
 * per detected speaker so the Speaker Naming Popup can play it for the user.
 *
 * Per the spec:
 *  - First segment with duration >= 2s; fall back to longest if none meet it.
 *  - Cap clip length at 8 seconds.
 *  - Resilient: if ffmpeg fails for one speaker, log and continue.
 *  - Returns a map of { speakerLabel: storageKey }. We deliberately do NOT
 *    sign the URL here — signed URLs go stale, and the meeting page
 *    re-signs every render with `getPresignedGetUrlForBrowser` so the
 *    browser gets a relative URL valid on whatever origin it loaded
 *    from. Speakers whose sample couldn't be extracted simply don't
 *    appear in the map; the UI handles that case (no play button).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { uploadBuffer, speakerSampleKey } from "./storage";
import type { DiarizationSegment } from "./diarization";
import { groupBySpeaker } from "./diarization";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const MIN_SEGMENT_SECONDS = 2;
const MAX_CLIP_SECONDS = 8;

type SampleResult = {
  /**
   * Map from raw pyannote label (e.g. "SPEAKER_00") to the *storage key*
   * of the extracted MP3 clip (NOT a signed URL). Callers should sign on
   * demand via getPresignedGetUrlForBrowser / getPresignedGetUrl.
   */
  sampleKeysByLabel: Map<string, string>;
  /** Stable list of all distinct speaker labels in original-appearance order. */
  speakerLabels: string[];
};

export async function extractSpeakerSamples({
  meetingId,
  audioSourceUrl,
  segments,
}: {
  meetingId: string;
  audioSourceUrl: string;
  segments: DiarizationSegment[];
}): Promise<SampleResult> {
  const grouped = groupBySpeaker(segments);
  const speakerLabels = Array.from(grouped.keys());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `held-${meetingId}-`));
  const sourceFile = path.join(tmpDir, `source-${randomUUID()}.audio`);
  const sampleKeysByLabel = new Map<string, string>();

  try {
    await downloadToFile(audioSourceUrl, sourceFile);

    for (const label of speakerLabels) {
      const speakerSegments = grouped.get(label) ?? [];
      const chosen = pickSample(speakerSegments);
      if (!chosen) continue;

      const { start, end } = chosen;
      const duration = Math.min(end - start, MAX_CLIP_SECONDS);
      if (duration <= 0) continue;

      const outFile = path.join(tmpDir, `sample-${randomUUID()}.mp3`);

      try {
        await sliceToMp3({ inFile: sourceFile, outFile, start, duration });
        const buf = await fs.readFile(outFile);

        const idx = speakerLabels.indexOf(label);
        const key = speakerSampleKey(meetingId, idx);
        await uploadBuffer({
          key,
          body: buf,
          contentType: "audio/mpeg",
          cacheControl: "private, max-age=3600",
        });

        // Store the KEY, not a URL. Signed URLs expire (1 h here) and
        // pre-baking one into the DB row means stale links once the
        // user reopens the page later. The meeting page signs fresh
        // every render via getPresignedGetUrlForBrowser.
        sampleKeysByLabel.set(label, key);
      } catch (err) {
        // Per spec: resilient — log and continue.
        console.error(
          `[extract-samples] failed to extract sample for ${label}:`,
          err
        );
      } finally {
        await fs.rm(outFile, { force: true }).catch(() => {});
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  return { sampleKeysByLabel, speakerLabels };
}

/**
 * Pick a {start,end} window for the speaker's sample clip.
 *
 * Why the merge step matters: pyannote routinely splits a continuous
 * speaker turn into many tiny adjacent segments (sub-second each) when
 * the speaker pauses to breathe, modulates volume, or moves closer/
 * further from the mic. The old behavior — picking the first single
 * segment >= 2s, falling back to the longest — would happily pick a
 * 0.5s slice when in reality the speaker had been talking for 30
 * seconds, just chopped up. Result: a play button that audibly clicks
 * for one syllable and stops.
 *
 * Fix: collapse the speaker's segments into MERGED RUNS first.
 * Adjacent segments with a gap of <= MERGE_GAP_SECONDS (= 1.5 s) are
 * fused into one continuous block, even though pyannote handed them
 * back separately. Then we pick from the merged blocks. This routinely
 * turns "10 × ~0.4s segments" into one 4-5 s sample window — exactly
 * what the popup play button needs.
 */
const MERGE_GAP_SECONDS = 1.5;

function pickSample(
  speakerSegments: DiarizationSegment[]
): { start: number; end: number } | null {
  if (speakerSegments.length === 0) return null;

  // Sort + merge adjacent runs for this speaker. We keep the original
  // segments untouched; the merged shape is a local optimisation just
  // for choosing the sample window.
  const sorted = [...speakerSegments].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && s.start - prev.end <= MERGE_GAP_SECONDS) {
      prev.end = Math.max(prev.end, s.end);
    } else {
      merged.push({ start: s.start, end: s.end });
    }
  }

  // First merged run >= MIN_SEGMENT_SECONDS wins — that's the earliest
  // chunk of continuous speech long enough to be a recognisable
  // sample.
  const firstClear = merged.find((r) => r.end - r.start >= MIN_SEGMENT_SECONDS);
  if (firstClear) return firstClear;

  // No merged run meets the 2 s floor. Pick the longest one we have;
  // mergeAdjacent already gave us the best possible contiguous block,
  // so this is genuinely the most-audio-we-can-extract for this
  // speaker.
  let longest = merged[0];
  for (const r of merged) {
    if (r.end - r.start > longest.end - longest.start) longest = r;
  }
  return longest;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download audio: ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
}

function sliceToMp3({
  inFile,
  outFile,
  start,
  duration,
}: {
  inFile: string;
  outFile: string;
  start: number;
  duration: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inFile)
      .setStartTime(start)
      .duration(duration)
      .audioCodec("libmp3lame")
      .audioBitrate("96k")
      .audioChannels(1)
      .format("mp3")
      .on("error", reject)
      .on("end", () => resolve())
      .save(outFile);
  });
}

// `Readable` is referenced indirectly via @types; keep the import so tree-shaking
// doesn't drop the stream polyfill required by some ffmpeg pipelines on Windows.
void Readable;
