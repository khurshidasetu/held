/**
 * LLM wrapper for meeting-summary generation.
 *
 * Selects a provider at call time:
 *   - OpenRouter (default) — OpenAI-compatible chat completions endpoint,
 *     proxies to Claude (and many others). Same request shape as OpenAI,
 *     different model slug.
 *   - Anthropic — direct messages.create API.
 *
 * Either way, the model is instructed to return a JSON object matching
 * SummaryJsonSchema; we strip code fences defensively and zod-validate.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "./env";
import type { ActionItem, Decision, Topic } from "@/db/schema";

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

const USER_PREFIX = "Here is the meeting transcript:\n\n";
const USER_SUFFIX = "\n\nReturn the JSON object.";

export async function summarizeTranscript(
  namedTranscript: string
): Promise<StructuredSummary> {
  const rawText =
    env.llm.provider === "openrouter"
      ? await callOpenRouter(namedTranscript)
      : await callAnthropic(namedTranscript);

  const stripped = stripCodeFences(rawText);

  let json: unknown;
  try {
    json = JSON.parse(stripped);
  } catch (err) {
    throw new Error(
      `LLM response was not valid JSON: ${(err as Error).message}\n---\n${stripped.slice(0, 500)}`
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

// ── Providers ────────────────────────────────────────────────────────────

async function callOpenRouter(transcript: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openrouter.apiKey}`,
      // Optional but recommended by OpenRouter — surfaces our app in their
      // rankings and helps with abuse triage.
      "HTTP-Referer": env.openrouter.referer,
      "X-Title": env.openrouter.title,
    },
    body: JSON.stringify({
      model: env.openrouter.model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${USER_PREFIX}${transcript}${USER_SUFFIX}` },
      ],
      // Ask for JSON when the underlying model supports it. Models that
      // don't honour this field ignore it; the prompt still demands JSON
      // and we strip code fences below.
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`OpenRouter error: ${data.error.message ?? "unknown"}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("OpenRouter returned no text content");
  }
  return text;
}

let _anthropic: Anthropic | undefined;
function anthropicClient(): Anthropic {
  return (_anthropic ??= new Anthropic({ apiKey: env.anthropic.apiKey }));
}

async function callAnthropic(transcript: string): Promise<string> {
  const response = await anthropicClient().messages.create({
    model: env.anthropic.model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${USER_PREFIX}${transcript}${USER_SUFFIX}`,
      },
    ],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text;
}

// Some prompts cause models to wrap JSON in ```json fences despite instructions.
function stripCodeFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}
