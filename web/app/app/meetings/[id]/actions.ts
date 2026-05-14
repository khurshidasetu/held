"use server";

import { getCurrentUserId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  meetings,
  meetingSummaries,
  emailSends,
} from "@/db";
import { sendMeetingEmail } from "@/lib/postmark";
import { env } from "@/lib/env";
import { revalidatePath } from "next/cache";

const RecipientsSchema = z.array(z.string().email()).min(1);

export type SendEmailsResult = {
  ok: boolean;
  sent: number;
  failed: { recipient: string; reason: string }[];
};

/**
 * Server action: send the meeting summary email to each recipient.
 *
 * Caller passes the final, deduped list (attendees + any extras the user
 * typed in the form). The action does its own auth check and validation,
 * since server actions are reachable over POST regardless of which UI
 * invokes them.
 */
export async function sendMeetingEmails(
  meetingId: string,
  recipients: string[]
): Promise<SendEmailsResult> {
  const userId = await getCurrentUserId();

  const cleaned = Array.from(
    new Set(recipients.map((r) => r.trim().toLowerCase()))
  ).filter((r) => r.length > 0);
  RecipientsSchema.parse(cleaned);

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) throw new Error("Meeting not found");
  if (meeting.status !== "complete") {
    throw new Error("Meeting is not ready to send");
  }

  const [summary] = await db
    .select()
    .from(meetingSummaries)
    .where(eq(meetingSummaries.meetingId, meetingId))
    .limit(1);

  if (!summary) throw new Error("Summary not available");

  const meetingUrl = `${env.appUrl}/app/meetings/${meetingId}`;

  let sent = 0;
  const failed: { recipient: string; reason: string }[] = [];

  for (const recipient of cleaned) {
    const result = await sendMeetingEmail({
      recipient,
      meetingTitle: meeting.title,
      meetingUrl,
      summary: summary.summary,
      nextStep: summary.nextStep,
      actionItems: summary.actionItems,
      decisions: summary.decisions,
      openQuestions: summary.openQuestions,
    });

    if (result.ok) {
      sent++;
      await db.insert(emailSends).values({
        meetingId,
        recipientEmail: recipient,
        postmarkMessageId: result.messageId,
      });
    } else {
      failed.push({
        recipient,
        reason: result.errorMessage ?? "Unknown send error",
      });
    }
  }

  revalidatePath(`/app/meetings/${meetingId}`);
  return { ok: failed.length === 0, sent, failed };
}
