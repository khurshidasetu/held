/**
 * POST /api/meetings/[id]/identify-speakers
 *
 * Called by the recorder after upload finishes. Runs diarization on the
 * uploaded audio, extracts a short sample clip per detected speaker, and
 * returns the list to the client for the Speaker Naming Popup.
 *
 * Side effects:
 *   - Writes speaker rows to the DB (so save-speakers can reference them)
 *   - Uploads sample clips to S3 under speaker-samples/{meeting_id}/
 *
 * The meeting stays in status 'awaiting_speaker_naming' throughout — only
 * the save-speakers endpoint advances it.
 */
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { getCurrentUserId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { db, meetings, speakers } from "@/db";
import { diarize } from "@/lib/diarization";
import { extractSpeakerSamples } from "@/lib/extract-samples";
import { getPresignedGetUrl, getInternalPresignedGetUrl } from "@/lib/storage";
import { downloadToTemp } from "@/lib/audio";
import { transcribeAudio } from "@/lib/stt";
import { mergeTranscript, renderNamedTranscript } from "@/lib/merge-transcript";
import { extractSpeakerNames } from "@/lib/llm";

export const runtime = "nodejs";
// Reads DB + calls external service, never prerender.
export const dynamic = "force-dynamic";
// Diarization can run 30-60s on short clips. Tell Next not to time out.
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Context) {
  const userId = await getCurrentUserId();

  const { id } = await ctx.params;

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!meeting.audioUrl) {
    return NextResponse.json(
      { error: "Meeting has no audio" },
      { status: 400 }
    );
  }
  if (meeting.status !== "awaiting_speaker_naming") {
    return NextResponse.json(
      { error: `Cannot identify speakers in status ${meeting.status}` },
      { status: 409 }
    );
  }

  // Two URLs over the same key:
  //   - audioUrlForDiarization: handed to the diarization service. When that
  //     service runs in Docker, the URL uses host.docker.internal so the
  //     container can reach our dev server on the host.
  //   - audioUrlForLocal:       used by extractSpeakerSamples, which runs in
  //     *this* process on the host — plain localhost is fine and avoids a
  //     pointless trip through Docker's networking.
  const audioUrlForDiarization = await getInternalPresignedGetUrl(
    meeting.audioUrl,
    30 * 60
  );
  const audioUrlForLocal = await getPresignedGetUrl(meeting.audioUrl, 30 * 60);

  let segments;
  try {
    segments = await diarize(audioUrlForDiarization);
  } catch (err) {
    console.error(`[identify-speakers] diarization failed for ${id}:`, err);
    await db
      .update(meetings)
      .set({
        status: "failed",
        errorMessage:
          err instanceof Error ? err.message : "Diarization failed",
      })
      .where(eq(meetings.id, id));
    return NextResponse.json(
      { error: "Diarization failed" },
      { status: 502 }
    );
  }

  if (segments.length === 0) {
    return NextResponse.json(
      { error: "No speech detected in the recording" },
      { status: 422 }
    );
  }

  const { sampleUrlsByLabel, speakerLabels } = await extractSpeakerSamples({
    meetingId: id,
    audioSourceUrl: audioUrlForLocal,
    segments,
  });

  // Clear any prior speaker rows for this meeting (e.g. a retry), then insert.
  await db.delete(speakers).where(eq(speakers.meetingId, id));

  // Optional pre-popup name extraction. We run a fast STT pass over the
  // whole audio and ask the LLM to pull any clear self-introductions
  // ("Hi I'm Alex", "ami Rakib bolchi") so the popup can render with the
  // name inputs pre-filled. Best-effort: if STT or the LLM call fails for
  // any reason, we still proceed with null displayNames and the popup
  // shows blank inputs (the user can name speakers themselves; /process
  // also re-runs name extraction as a fallback).
  const inferredNames = await tryInferNames({
    audioUrlForLocal,
    segments,
    speakerLabels,
  });

  // Clear any prior speaker rows for this meeting (e.g. a retry), then insert.
  await db.delete(speakers).where(eq(speakers.meetingId, id));

  await db.insert(speakers).values(
    speakerLabels.map((label) => ({
      meetingId: id,
      speakerLabel: label,
      sampleAudioUrl: sampleUrlsByLabel.get(label) ?? null,
      isSilentAttendee: false,
      displayName: inferredNames.get(label) ?? null,
    }))
  );

  // Cache the raw diarization output so the process route can merge it with
  // the transcript without re-running diarization.
  await db
    .update(meetings)
    .set({ diarizationSegments: segments })
    .where(eq(meetings.id, id));

  return NextResponse.json({
    speakers: speakerLabels.map((label) => ({
      speakerLabel: label,
      sampleUrl: sampleUrlsByLabel.get(label) ?? null,
      inferredName: inferredNames.get(label) ?? null,
    })),
  });
}

/**
 * Pre-popup name inference: transcribe the audio, merge with speaker
 * segments, ask the LLM to extract self-introductions, map back from
 * "Speaker N" positional labels to the pyannote labels we use as primary
 * keys. Best-effort throughout — any failure returns an empty map and
 * the rest of the flow proceeds.
 */
async function tryInferNames({
  audioUrlForLocal,
  segments,
  speakerLabels,
}: {
  audioUrlForLocal: string;
  segments: { speaker: string; start: number; end: number }[];
  speakerLabels: string[];
}): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let tmpDir: string | undefined;
  try {
    const dl = await downloadToTemp(audioUrlForLocal, "identify-audio");
    tmpDir = dl.dir;
    const words = await transcribeAudio(dl.filePath);
    if (words.length === 0) return result;

    const utterances = mergeTranscript(words, segments);
    if (utterances.length === 0) return result;

    // Render with positional "Speaker N" labels — same scheme the LLM
    // prompt and the popup both use.
    const positionalLabelFor = (pyannoteLabel: string) => {
      const idx = speakerLabels.indexOf(pyannoteLabel);
      return idx >= 0 ? `Speaker ${idx + 1}` : pyannoteLabel;
    };
    const named = renderNamedTranscript(utterances, positionalLabelFor);

    const extracted = await extractSpeakerNames(named);
    for (const { label, name } of extracted) {
      // "Speaker N" → array index → pyannote label
      const match = label.match(/^Speaker\s+(\d+)$/i);
      if (!match) continue;
      const idx = parseInt(match[1], 10) - 1;
      const pyannoteLabel = speakerLabels[idx];
      if (!pyannoteLabel) continue;
      result.set(pyannoteLabel, name);
    }
  } catch (err) {
    console.warn(`[identify-speakers] name inference skipped:`, err);
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return result;
}
