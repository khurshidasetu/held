/**
 * Postmark wrapper for sending the meeting-notes email.
 *
 * One email per recipient (not BCC) so we can record per-recipient delivery
 * in the email_sends table and so each person gets a clean "to: them" header.
 */
import { ServerClient } from "postmark";
import { env } from "./env";

// Lazy: see lib/anthropic.ts for the rationale.
let _client: ServerClient | undefined;
function client(): ServerClient {
  return (_client ??= new ServerClient(env.postmark.token));
}

export type MeetingEmailPayload = {
  recipient: string;
  meetingTitle: string;
  meetingUrl: string;
  summary: string;
  actionItems: { text: string; owner?: string | null; dueDate?: string | null }[];
  decisions: { text: string; rationale?: string | null }[];
  topics: { name: string; summary?: string | null }[];
};

export type SendResult = {
  recipient: string;
  messageId: string | null;
  ok: boolean;
  errorMessage?: string;
};

export async function sendMeetingEmail(
  payload: MeetingEmailPayload
): Promise<SendResult> {
  const subject = `[Minutely] Notes from "${payload.meetingTitle}"`;
  const { html, text } = renderBodies(payload);

  try {
    const res = await client().sendEmail({
      From: `"${env.postmark.fromName}" <${env.postmark.fromEmail}>`,
      To: payload.recipient,
      Subject: subject,
      HtmlBody: html,
      TextBody: text,
      MessageStream: "outbound",
    });
    return {
      recipient: payload.recipient,
      messageId: res.MessageID ?? null,
      ok: true,
    };
  } catch (err) {
    return {
      recipient: payload.recipient,
      messageId: null,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function renderBodies(p: MeetingEmailPayload): { html: string; text: string } {
  const text = [
    `Minutely — Notes from "${p.meetingTitle}"`,
    "",
    "Summary",
    "-------",
    p.summary,
    "",
    p.actionItems.length
      ? [
          "Action items",
          "------------",
          ...p.actionItems.map(
            (a) =>
              `- ${a.text}${a.owner ? ` (${a.owner})` : ""}${a.dueDate ? ` — ${a.dueDate}` : ""}`
          ),
          "",
        ].join("\n")
      : "",
    p.decisions.length
      ? [
          "Decisions",
          "---------",
          ...p.decisions.map(
            (d) => `- ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`
          ),
          "",
        ].join("\n")
      : "",
    p.topics.length
      ? [
          "Topics",
          "------",
          ...p.topics.map(
            (t) => `- ${t.name}${t.summary ? `: ${t.summary}` : ""}`
          ),
          "",
        ].join("\n")
      : "",
    `View the full transcript: ${p.meetingUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const html = `
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:600px;margin:0 auto;padding:24px;">
    <div style="font-size:13px;color:#4f46e5;letter-spacing:0.04em;text-transform:uppercase;font-weight:600;">Minutely</div>
    <h1 style="font-size:22px;margin:6px 0 20px;">Notes from &ldquo;${escape(p.meetingTitle)}&rdquo;</h1>

    <h2 style="font-size:15px;margin:24px 0 8px;color:#475569;text-transform:uppercase;letter-spacing:0.05em;">Summary</h2>
    <p style="line-height:1.55;margin:0 0 16px;">${escape(p.summary)}</p>

    ${
      p.actionItems.length
        ? `<h2 style="font-size:15px;margin:24px 0 8px;color:#475569;text-transform:uppercase;letter-spacing:0.05em;">Action items</h2>
           <ul style="line-height:1.55;padding-left:20px;margin:0 0 16px;">
             ${p.actionItems
               .map(
                 (a) =>
                   `<li>${escape(a.text)}${a.owner ? ` <em>(${escape(a.owner)})</em>` : ""}${a.dueDate ? ` &mdash; ${escape(a.dueDate)}` : ""}</li>`
               )
               .join("")}
           </ul>`
        : ""
    }

    ${
      p.decisions.length
        ? `<h2 style="font-size:15px;margin:24px 0 8px;color:#475569;text-transform:uppercase;letter-spacing:0.05em;">Decisions</h2>
           <ul style="line-height:1.55;padding-left:20px;margin:0 0 16px;">
             ${p.decisions
               .map(
                 (d) =>
                   `<li>${escape(d.text)}${d.rationale ? ` &mdash; <em>${escape(d.rationale)}</em>` : ""}</li>`
               )
               .join("")}
           </ul>`
        : ""
    }

    ${
      p.topics.length
        ? `<h2 style="font-size:15px;margin:24px 0 8px;color:#475569;text-transform:uppercase;letter-spacing:0.05em;">Topics</h2>
           <ul style="line-height:1.55;padding-left:20px;margin:0 0 16px;">
             ${p.topics
               .map(
                 (t) =>
                   `<li><strong>${escape(t.name)}</strong>${t.summary ? `: ${escape(t.summary)}` : ""}</li>`
               )
               .join("")}
           </ul>`
        : ""
    }

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:14px;color:#64748b;margin:0;">
      <a href="${p.meetingUrl}" style="color:#4f46e5;text-decoration:none;">View the full transcript &rarr;</a>
    </p>
  </body>
</html>`.trim();

  return { html, text };
}
