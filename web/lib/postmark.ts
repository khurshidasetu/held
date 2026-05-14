/**
 * Postmark wrapper for sending the Held result-card email.
 *
 * One email per recipient (not BCC) so we can record per-recipient delivery
 * in the email_sends table and so each person gets a clean "to: them" header.
 *
 * Body layout mirrors the in-app Result Card: lead with Next Step, then
 * Decisions, Action items, Open questions. Summary is at the bottom for
 * context. No transcript inline — only a link.
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
  nextStep: string | null;
  actionItems: { text: string; owner?: string | null; dueDate?: string | null }[];
  decisions: { text: string; rationale?: string | null }[];
  openQuestions: { text: string }[];
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
  const subject = `Held: ${payload.meetingTitle}`;
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
  const sections: string[] = [
    `Held — Result from "${p.meetingTitle}"`,
    "",
  ];

  if (p.nextStep) {
    sections.push("Next step", "---------", p.nextStep, "");
  }

  if (p.decisions.length) {
    sections.push("Decisions", "---------");
    for (const d of p.decisions) {
      sections.push(
        `- ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`
      );
    }
    sections.push("");
  }

  if (p.actionItems.length) {
    sections.push("Action items", "------------");
    for (const a of p.actionItems) {
      sections.push(
        `- ${a.text}${a.owner ? ` (${a.owner})` : ""}${a.dueDate ? ` — ${a.dueDate}` : ""}`
      );
    }
    sections.push("");
  }

  if (p.openQuestions.length) {
    sections.push("Open questions", "--------------");
    for (const q of p.openQuestions) {
      sections.push(`- ${q.text}`);
    }
    sections.push("");
  }

  sections.push("Context", "-------", p.summary, "");
  sections.push(`View the full transcript: ${p.meetingUrl}`);

  const text = sections.join("\n");

  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const sectionH = (title: string) =>
    `<h2 style="font-size:13px;margin:24px 0 8px;color:#475569;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">${title}</h2>`;

  const nextStepBlock = p.nextStep
    ? `
        ${sectionH("Next step")}
        <div style="background:#eef2ff;border-left:4px solid #4f46e5;padding:14px 16px;border-radius:6px;line-height:1.5;font-size:16px;color:#0f172a;">
          ${escape(p.nextStep)}
        </div>
      `
    : "";

  const decisionsBlock = p.decisions.length
    ? `
        ${sectionH("Decisions")}
        <ul style="line-height:1.55;padding-left:20px;margin:0 0 16px;">
          ${p.decisions
            .map(
              (d) =>
                `<li>${escape(d.text)}${d.rationale ? ` <span style="color:#64748b;">— ${escape(d.rationale)}</span>` : ""}</li>`
            )
            .join("")}
        </ul>`
    : "";

  const actionsBlock = p.actionItems.length
    ? `
        ${sectionH("Action items")}
        <ul style="line-height:1.55;padding-left:20px;margin:0 0 16px;">
          ${p.actionItems
            .map(
              (a) =>
                `<li>${escape(a.text)}${a.owner ? ` <em style="color:#475569;">(${escape(a.owner)})</em>` : ""}${a.dueDate ? ` <span style="color:#64748b;">— ${escape(a.dueDate)}</span>` : ""}</li>`
            )
            .join("")}
        </ul>`
    : "";

  const questionsBlock = p.openQuestions.length
    ? `
        ${sectionH("Open questions")}
        <ul style="line-height:1.55;padding-left:20px;margin:0 0 16px;">
          ${p.openQuestions.map((q) => `<li>${escape(q.text)}</li>`).join("")}
        </ul>`
    : "";

  const html = `
<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:600px;margin:0 auto;padding:24px;">
    <div style="font-size:13px;color:#4f46e5;letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Held</div>
    <h1 style="font-size:22px;margin:6px 0 20px;">Result from &ldquo;${escape(p.meetingTitle)}&rdquo;</h1>

    ${nextStepBlock}
    ${decisionsBlock}
    ${actionsBlock}
    ${questionsBlock}

    ${sectionH("Context")}
    <p style="line-height:1.55;margin:0 0 16px;color:#475569;">${escape(p.summary)}</p>

    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:14px;color:#64748b;margin:0;">
      <a href="${p.meetingUrl}" style="color:#4f46e5;text-decoration:none;">Open in Held &rarr;</a>
    </p>
  </body>
</html>`.trim();

  return { html, text };
}
