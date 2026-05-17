/**
 * Align Cartesia word timestamps with pyannote speaker segments to produce
 * a named transcript:
 *   [{ speakerLabel: "SPEAKER_00", startSeconds, endSeconds, text }, ...]
 *
 * Two accuracy improvements over the original:
 *
 *   1. `cleanSegments` runs first to drop diarization artifacts:
 *      • Segments shorter than 250ms are usually noise/cross-talk that
 *        pyannote couldn't confidently cluster, not real speech turns.
 *      • Adjacent same-speaker segments separated by ≤500ms get merged —
 *        pyannote often emits a tight back-to-back chain when a single
 *        person pauses for breath, which fragments the transcript and
 *        confuses the per-word lookup.
 *
 *   2. Per-word speaker assignment uses MAX OVERLAP rather than the word
 *      midpoint. A word straddling a boundary now goes to whichever
 *      speaker actually owns the larger share of its time range, instead
 *      of being blindly handed to whoever owns the midpoint pixel. The
 *      no-overlap snap radius is also tightened from 1.0s → 0.3s so
 *      stray words don't get pulled into the wrong speaker's mouth.
 *
 * Silent attendees (no audio) are filtered out — they have no segments.
 */
import type { Word } from "./stt";
import type { DiarizationSegment } from "./diarization";

export type MergedUtterance = {
  speakerLabel: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export function mergeTranscript(
  words: Word[],
  segments: DiarizationSegment[]
): MergedUtterance[] {
  if (words.length === 0) return [];

  const cleaned = cleanSegments(segments);
  if (cleaned.length === 0) return [];

  const utterances: MergedUtterance[] = [];
  let current: MergedUtterance | null = null;

  for (const w of words) {
    const speaker = assignWordToSpeaker(cleaned, w.start, w.end);
    if (!speaker) continue;

    if (current && current.speakerLabel === speaker) {
      current.text += ` ${w.text}`;
      current.endSeconds = w.end;
    } else {
      if (current) utterances.push(current);
      current = {
        speakerLabel: speaker,
        startSeconds: w.start,
        endSeconds: w.end,
        text: w.text,
      };
    }
  }
  if (current) utterances.push(current);

  return utterances.map((u) => ({ ...u, text: u.text.trim() }));
}

/**
 * Defensive post-processing for raw pyannote output. Exported so callers
 * that *display* diarization (e.g. sample extraction) can also benefit
 * from the cleanup — but mergeTranscript already calls it.
 *
 * minDurationSeconds  — drop segments shorter than this; usually noise.
 * maxGapSeconds       — merge adjacent same-speaker segments with a gap
 *                       ≤ this; pyannote sometimes splits a single
 *                       continuous utterance into chained tiny pieces.
 */
export function cleanSegments(
  segments: DiarizationSegment[],
  opts: { minDurationSeconds?: number; maxGapSeconds?: number } = {}
): DiarizationSegment[] {
  // 100ms threshold: just enough to drop pyannote's tiniest mis-clusters
  // (sub-50ms blips that show up on noise) without nuking legitimate short
  // turns like "Yes", "OK", "No" — those routinely come in around
  // 200-400ms and used to disappear with the previous 250ms floor.
  const minDuration = opts.minDurationSeconds ?? 0.1;
  const maxGap = opts.maxGapSeconds ?? 0.5;

  const filtered = segments
    .filter((s) => s.end - s.start >= minDuration)
    .sort((a, b) => a.start - b.start);

  const merged: DiarizationSegment[] = [];
  for (const s of filtered) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === s.speaker && s.start - prev.end <= maxGap) {
      // Stretch the previous segment to cover this one. We don't average
      // start times — keep the original start so the speaker's first
      // word still aligns with their first audible moment.
      prev.end = Math.max(prev.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

/**
 * Pick the speaker whose segment overlaps the word's [start,end] range
 * the most. If no segment overlaps at all (e.g. word falls in a tiny
 * gap), snap to the nearest segment within 0.3s — beyond that we'd be
 * guessing, so we drop the word from the transcript instead of putting
 * words in someone's mouth.
 */
function assignWordToSpeaker(
  sortedSegments: DiarizationSegment[],
  wordStart: number,
  wordEnd: number
): string | null {
  let bestSpeaker: string | null = null;
  let bestOverlap = 0;
  for (const s of sortedSegments) {
    const overlapStart = Math.max(wordStart, s.start);
    const overlapEnd = Math.min(wordEnd, s.end);
    const overlap = overlapEnd - overlapStart;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestSpeaker = s.speaker;
    }
  }
  if (bestSpeaker) return bestSpeaker;

  // No overlap path: tight snap. 0.3s is the typical inter-word gap when
  // a single speaker pauses for breath — anything wider and we risk
  // attributing a stray word to the wrong person.
  const wordMid = (wordStart + wordEnd) / 2;
  let nearestSpeaker: string | null = null;
  let nearestDistance = Infinity;
  for (const s of sortedSegments) {
    const d =
      wordMid < s.start ? s.start - wordMid : wordMid > s.end ? wordMid - s.end : 0;
    if (d < nearestDistance) {
      nearestDistance = d;
      nearestSpeaker = s.speaker;
    }
  }
  return nearestSpeaker && nearestDistance <= 0.3 ? nearestSpeaker : null;
}

/**
 * Render a list of utterances as a plain "Name: text" transcript suitable
 * for feeding to the LLM. `nameFor(label)` returns the display name for a
 * speaker label.
 */
export function renderNamedTranscript(
  utterances: MergedUtterance[],
  nameFor: (speakerLabel: string) => string
): string {
  return utterances
    .map((u) => `${nameFor(u.speakerLabel)}: ${u.text}`)
    .join("\n");
}
