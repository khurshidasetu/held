/**
 * Align Cartesia word timestamps with pyannote speaker segments to produce
 * a named transcript:
 *   [{ speakerLabel: "SPEAKER_00", startSeconds, endSeconds, text }, ...]
 *
 * Strategy: for each word, find the speaker segment whose [start, end] range
 * the word's midpoint falls into. Then group consecutive same-speaker words
 * into one utterance.
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

  // Sort segments by start time for binary search.
  const sorted = [...segments].sort((a, b) => a.start - b.start);

  const utterances: MergedUtterance[] = [];
  let current: MergedUtterance | null = null;

  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    const speaker = findSpeakerAt(sorted, mid);
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

function findSpeakerAt(
  sortedSegments: DiarizationSegment[],
  t: number
): string | null {
  // Linear scan is fine for meeting-scale segment counts (usually < few hundred).
  // If this becomes hot, swap for a binary search.
  let best: DiarizationSegment | null = null;
  let bestDistance = Infinity;
  for (const s of sortedSegments) {
    if (t >= s.start && t <= s.end) return s.speaker;
    const d = t < s.start ? s.start - t : t - s.end;
    if (d < bestDistance) {
      bestDistance = d;
      best = s;
    }
  }
  // Snap to nearest segment within 1s, otherwise drop the word.
  return best && bestDistance <= 1.0 ? best.speaker : null;
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
