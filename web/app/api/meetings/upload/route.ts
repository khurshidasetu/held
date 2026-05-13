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
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, meetings, attendees } from "@/db";
import { audioKey, uploadBuffer } from "@/lib/s3";

export const runtime = "nodejs";

const AttendeeListSchema = z.array(z.string().email());

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  // Create row first so we have an id to scope the S3 key under.
  const [created] = await db
    .insert(meetings)
    .values({
      userId,
      title: title.trim(),
      durationSeconds,
      status: "awaiting_speaker_naming",
    })
    .returning({ id: meetings.id });

  if (!created) {
    return NextResponse.json(
      { error: "Failed to create meeting" },
      { status: 500 }
    );
  }

  const key = audioKey(created.id, ext);
  const buf = Buffer.from(await audio.arrayBuffer());

  await uploadBuffer({
    key,
    body: buf,
    contentType,
    cacheControl: "private, max-age=0",
  });

  await db
    .update(meetings)
    .set({ audioUrl: key })
    .where(eq(meetings.id, created.id));

  if (attendeeEmails.length > 0) {
    await db.insert(attendees).values(
      attendeeEmails.map((email) => ({
        meetingId: created.id,
        email,
      }))
    );
  }

  return NextResponse.json({ meetingId: created.id });
}
