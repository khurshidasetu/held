/**
 * Client for our self-hosted FastAPI / pyannote.audio diarization service.
 *
 * Contract (must match diarization/app/main.py):
 *
 *   POST /diarize
 *     Headers: X-API-Key: <DIARIZATION_SERVICE_API_KEY>
 *     Body:    { "audio_url": "<presigned GET URL>" }
 *     200:     { "segments": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 3.4 }, ...] }
 */
import { z } from "zod";
import { env } from "./env";

export const DiarizationSegmentSchema = z.object({
  speaker: z.string(),
  start: z.number(),
  end: z.number(),
});

export type DiarizationSegment = z.infer<typeof DiarizationSegmentSchema>;

const DiarizationResponseSchema = z.object({
  segments: z.array(DiarizationSegmentSchema),
});

export async function diarize(audioUrl: string): Promise<DiarizationSegment[]> {
  const res = await fetch(`${env.diarization.url}/diarize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.diarization.apiKey,
    },
    body: JSON.stringify({ audio_url: audioUrl }),
    // Diarization is slow (often 30-60s for short meetings). Override the
    // default fetch timeout if the runtime imposes one.
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Diarization service returned ${res.status}: ${body.slice(0, 500)}`
    );
  }

  const json: unknown = await res.json();
  const parsed = DiarizationResponseSchema.parse(json);
  return parsed.segments;
}

/**
 * Group raw diarization segments by speaker label, preserving original order.
 */
export function groupBySpeaker(
  segments: DiarizationSegment[]
): Map<string, DiarizationSegment[]> {
  const m = new Map<string, DiarizationSegment[]>();
  for (const seg of segments) {
    const existing = m.get(seg.speaker);
    if (existing) existing.push(seg);
    else m.set(seg.speaker, [seg]);
  }
  return m;
}
