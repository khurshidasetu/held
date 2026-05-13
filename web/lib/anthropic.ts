/**
 * Claude Sonnet 4.5 wrapper for producing meeting summaries.
 *
 * Returns a structured object: summary text + action items + decisions +
 * topics. The model is instructed to respond as JSON and we validate with zod
 * so a malformed response is caught at the boundary.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "./env";
import type { ActionItem, Decision, Topic } from "@/db/schema";

// Lazy so module load doesn't read env vars — Next 16 collects page data in
// workers that may not have the runtime env populated yet, and we don't want
// to fail the build just because we imported this module.
let _anthropic: Anthropic | undefined;
function client(): Anthropic {
  return (_anthropic ??= new Anthropic({ apiKey: env.anthropic.apiKey }));
}

const SummaryJsonSchema = z.object({
  summary: z.string().min(1),
  action_items: z
    .array(
      z.object({
        text: z.string(),
        owner: z.string().nullable().optional(),
        due_date: z.string().nullable().optional(),
      })
    )
    .default([]),
  decisions: z
    .array(
      z.object({
        text: z.string(),
        rationale: z.string().nullable().optional(),
      })
    )
    .default([]),
  topics: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string().nullable().optional(),
      })
    )
    .default([]),
});

export type StructuredSummary = {
  summary: string;
  actionItems: ActionItem[];
  decisions: Decision[];
  topics: Topic[];
};

const SYSTEM_PROMPT = `You are summarizing a meeting transcript for the participants.

You will receive a transcript where each line is prefixed with the speaker's
name, like "Sarah: I think we should ship Friday." Some speakers may be labeled
generically (e.g. "Speaker 1") if the user did not name them.

Produce a JSON object with exactly these top-level fields:
  - "summary": a concise 3-6 sentence narrative summary, in the past tense
  - "action_items": an array of objects { text, owner, due_date }
      * owner is the name of the person who owns the action, or null
      * due_date is a free-text deadline like "Friday" or "next sprint", or null
  - "decisions": an array of objects { text, rationale }
      * rationale is one sentence on why, or null
  - "topics": an array of objects { name, summary }
      * 2-6 topics that span the meeting; summary is one sentence

Reply with ONLY a JSON object. No prose before or after, no markdown code
fences. Use double quotes. Do not invent action items or decisions that were
not actually discussed.`;

export async function summarizeTranscript(
  namedTranscript: string
): Promise<StructuredSummary> {
  const response = await client().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here is the meeting transcript:\n\n${namedTranscript}\n\nReturn the JSON object.`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  const raw = stripCodeFences(textBlock.text);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Claude response was not valid JSON: ${(err as Error).message}\n---\n${raw.slice(0, 500)}`
    );
  }

  const parsed = SummaryJsonSchema.parse(json);

  return {
    summary: parsed.summary,
    actionItems: parsed.action_items.map((a) => ({
      text: a.text,
      owner: a.owner ?? null,
      dueDate: a.due_date ?? null,
    })),
    decisions: parsed.decisions.map((d) => ({
      text: d.text,
      rationale: d.rationale ?? null,
    })),
    topics: parsed.topics.map((t) => ({
      name: t.name,
      summary: t.summary ?? null,
    })),
  };
}

// Some prompts cause Claude to wrap JSON in ```json fences despite instructions.
function stripCodeFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}
