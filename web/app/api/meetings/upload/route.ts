/**
 * POST /api/meetings/upload
 *
 * Accepts a multipart/form-data body with:
 *   - audio: File (audio/webm or audio/mp4)
 *   - title: string
 *   - attendees: JSON string array of emails
 *   - durationSeconds: string (integer)
 *
 * Uploads the audio to S3, creates a meeting row with status
 * 'awaiting_speaker_naming', persists the attendees, and returns
 * { meetingId }.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, meetings, attendees } from "@/db";
import { getCurrentUserId } from "@/lib/auth";
import { env } from "@/lib/env";
import { audioKey, uploadBuffer } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AttendeeListSchema = z.array(z.string().email());

export async function POST(request: Request) {
  const userId = await getCurrentUserId();

  const form = await request.formData();

  const audio = form.get("audio");
  const title = form.get("title");
  const attendeesRaw = form.get("attendees");
  const durationRaw = form.get("durationSeconds");

  if (!(audio instanceof File) || audio.size === 0) {
    return NextResponse.json(
      { error: "Missing or empty audio file" },
      { status: 400 }
    );
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "Missing title" }, { status: 400 });
  }

  let attendeeEmails: string[] = [];
  if (typeof attendeesRaw === "string" && attendeesRaw.length > 0) {
    try {
      attendeeEmails = AttendeeListSchema.parse(JSON.parse(attendeesRaw));
    } catch {
      return NextResponse.json(
        { error: "Invalid attendees list" },
        { status: 400 }
      );
    }
  }

  const durationSeconds =
    typeof durationRaw === "string" && /^\d+$/.test(durationRaw)
      ? parseInt(durationRaw, 10)
      : null;

  // Pick a file extension we know S3 + ffmpeg can read back.
  const ext =
    audio.type.includes("mp4") || audio.name.endsWith(".mp4")
      ? "mp4"
      : "webm";
  const contentType = audio.type || (ext === "mp4" ? "audio/mp4" : "audio/webm");

  // Generate the id client-side. MySQL has no RETURNING clause, so we can't
  // get the id back from the INSERT; generating it here keeps the flow
  // single-roundtrip and lets us name the S3 key before the row exists.
  const meetingId = randomUUID();
  const key = audioKey(meetingId, ext);
  const buf = Buffer.from(await audio.arrayBuffer());

  await uploadBuffer({
    key,
    body: buf,
    contentType,
    cacheControl: "private, max-age=0",
  });

  await db.insert(meetings).values({
    id: meetingId,
    userId,
    title: title.trim(),
    audioUrl: key,
    durationSeconds,
    status: "awaiting_speaker_naming",
  });

  if (attendeeEmails.length > 0) {
    await db.insert(attendees).values(
      attendeeEmails.map((email) => ({
        meetingId,
        email,
      }))
    );
  }

  // Kick off the two slow stages of the pipeline IN PARALLEL:
  //
  //   1. identify-speakers: diarization + sample extraction + speaker rows.
  //      Drives the naming popup.
  //   2. transcribe-words: STT pass over the same audio, cached on the
  //      meeting row.
  //
  // They don't depend on each other — diarization just needs the audio,
  // STT just needs the audio. Running them sequentially (the old shape)
  // made the user wait diarization_time + stt_time end-to-end. With both
  // fired in parallel, total wall time is max(diarization, stt) + the
  // user's naming time. /process can then skip the STT step (cache hit)
  // and go straight to merge + summary, which is a few seconds.
  //
  // Both are fire-and-forget. The naming popup polls for diarization to
  // finish; /process tolerates the STT cache being missing and runs it
  // inline as a fallback if needed.
  void triggerIdentifySpeakers(meetingId);
  void triggerTranscribeWords(meetingId);

  return NextResponse.json({ meetingId });
}

async function triggerIdentifySpeakers(meetingId: string): Promise<void> {
  try {
    await fetch(`${env.appUrl}/api/meetings/${meetingId}/identify-speakers`, {
      method: "POST",
    });
  } catch (err) {
    console.error(
      `[upload] failed to trigger identify-speakers for ${meetingId}:`,
      err
    );
  }
}

async function triggerTranscribeWords(meetingId: string): Promise<void> {
  try {
    await fetch(`${env.appUrl}/api/meetings/${meetingId}/transcribe-words`, {
      method: "POST",
      headers: { "X-Internal-Secret": env.internalWorkerSecret },
    });
  } catch (err) {
    // Same fire-and-forget pattern — best effort. /process will run STT
    // itself if the cache is missing when it gets there.
    console.error(
      `[upload] failed to trigger transcribe-words for ${meetingId}:`,
      err
    );
  }
}
