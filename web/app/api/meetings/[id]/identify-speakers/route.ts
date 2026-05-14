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
import { getCurrentUserId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { db, meetings, speakers } from "@/db";
import { diarize } from "@/lib/diarization";
import { extractSpeakerSamples } from "@/lib/extract-samples";
import { getPresignedGetUrl, getInternalPresignedGetUrl } from "@/lib/storage";

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

  await db.insert(speakers).values(
    speakerLabels.map((label) => ({
      meetingId: id,
      speakerLabel: label,
      sampleAudioUrl: sampleUrlsByLabel.get(label) ?? null,
      isSilentAttendee: false,
      displayName: null,
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
    })),
  });
}
