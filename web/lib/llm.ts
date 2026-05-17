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
import type { ActionItem, Decision, OpenQuestion } from "@/db/schema";

const SummaryJsonSchema = z.object({
  summary: z.string().min(1),
  next_step: z.string().nullable().optional(),
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
  open_questions: z
    .array(z.object({ text: z.string() }))
    .default([]),
  // Map from the generic label (e.g. "Speaker 1") to a real name detected
  // from self-introductions in the transcript ("Hi I'm Alex", "ami Rakib"
  // etc.). Caller applies these only to speakers whose displayName is null
  // — never overwrites a name the user typed in the popup.
  speaker_names: z
    .array(
      z.object({
        label: z.string(),
        name: z.string().min(1),
      })
    )
    .default([]),
});

export type StructuredSummary = {
  summary: string;
  nextStep: string | null;
  actionItems: ActionItem[];
  decisions: Decision[];
  openQuestions: OpenQuestion[];
  /** Inferred mapping: "Speaker N" → real name, from in-transcript self-intros. */
  speakerNames: { label: string; name: string }[];
};

// Held's Result Card model: ship the answer, not a recap.
// Four headline fields shown in the UI; `summary` is kept for the email body
// and the expanded transcript context view.
const SYSTEM_PROMPT = `You are producing a Held "Result Card" for a meeting.
Held ships the answer, not a transcript: a single next step, the decisions
that were made, the action items with owners and deadlines, and any open
questions left on the table.

You will receive a transcript where each line is prefixed with the speaker's
name, like "Sarah: I think we should ship Friday." Speakers may be labeled
generically (e.g. "Speaker 1") if the user did not name them.

Produce a JSON object with exactly these top-level fields:
  - "summary": 2-4 sentences of context, in the past tense. Used for the
    email body, not the Result Card hero. Keep it factual.
  - "next_step": ONE short sentence — the single most important next action
    coming out of this meeting. Null only if the meeting truly produced
    nothing actionable.
  - "decisions": array of { text, rationale }. rationale is one sentence or
    null. Include only decisions that were actually made.
  - "action_items": array of { text, owner, due_date }.
    * owner: the person's name if you can attribute it from the transcript
      (either someone volunteered with "I'll" / "I can take that" or another
      speaker assigned it). If the speaker is labeled "Speaker N" and you
      cannot infer a real name, set owner to null. Never invent names.
    * due_date: free-text like "Friday", "EOD", "next sprint", or null.
  - "open_questions": array of { text }. Things raised but not resolved.
  - "speaker_names": array of { label, name }. For any speaker whose line
    prefix is a generic placeholder ("Speaker 1", "Speaker 2", etc.) AND who
    introduces themselves in the transcript ("Hi I'm Alex", "Hello, my name
    is Sarah", "ami Rakib bolchi", "amar nam Tareq" — these can be in any
    language, including Bangla/English code-switching), output the mapping
    so the app can replace the generic label with their real name. Use the
    EXACT label that appears in the transcript prefix as the "label" value.
    Only include speakers whose self-intro is unambiguous; never invent
    names. Empty array if nobody self-introduces.

Reply with ONLY a JSON object. No prose before or after, no markdown code
fences. Use double quotes. Do not invent decisions, actions, or questions
that were not actually discussed.`;

const USER_PREFIX = "Here is the meeting transcript:\n\n";
const USER_SUFFIX = "\n\nReturn the JSON object.";

/**
 * Generic single-turn completion. Picks the active provider, returns the
 * raw text. Higher-level wrappers (summarizeTranscript, extractSpeakerNames)
 * build their own prompts and parse the response.
 */
async function complete({
  system,
  user,
  maxTokens,
}: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  switch (env.llm.provider) {
    case "openrouter":
      return callOpenRouter({ system, user, maxTokens });
    case "anthropic":
      return callAnthropic({ system, user, maxTokens });
  }
}

export async function summarizeTranscript(
  namedTranscript: string
): Promise<StructuredSummary> {
  const rawText = await complete({
    system: SYSTEM_PROMPT,
    user: `${USER_PREFIX}${namedTranscript}${USER_SUFFIX}`,
    maxTokens: 1500,
  });

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
    nextStep: parsed.next_step?.trim() || null,
    actionItems: parsed.action_items.map((a) => ({
      text: a.text,
      owner: a.owner ?? null,
      dueDate: a.due_date ?? null,
    })),
    decisions: parsed.decisions.map((d) => ({
      text: d.text,
      rationale: d.rationale ?? null,
    })),
    openQuestions: parsed.open_questions.map((q) => ({ text: q.text })),
    speakerNames: parsed.speaker_names.map((s) => ({
      label: s.label.trim(),
      name: s.name.trim(),
    })),
  };
}

// ── Providers ────────────────────────────────────────────────────────────

async function callOpenRouter({
  system,
  user,
  maxTokens,
}: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
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
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Ask for JSON when the underlying model supports it. Models that
      // don't honour this field ignore it; the prompt still demands JSON
      // and we strip code fences below.
      response_format: { type: "json_object" },
      // Match the team's OpenRouter privacy guardrail: only route to
      // upstream endpoints that don't log/train on our prompts. Without
      // this, the team's account-level "data policy" filter rejects every
      // candidate provider with:
      //   404 "No endpoints available matching your guardrail restrictions
      //       and data policy."
      // Docs: https://openrouter.ai/docs/use-cases/provider-routing
      //   - data_collection: "deny" → require zero-log providers
      //   - allow_fallbacks: true   → try Vertex if AI Studio is filtered,
      //                                etc., instead of failing outright
      provider: {
        data_collection: "deny",
        allow_fallbacks: true,
      },
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

async function callAnthropic({
  system,
  user,
  maxTokens,
}: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const response = await anthropicClient().messages.create({
    model: env.anthropic.model,
    max_tokens: maxTokens,
    system,
    messages: [
      {
        role: "user",
        content: user,
      },
    ],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Claude returned no text content");
  }
  return textBlock.text;
}

// ── Speaker-name extraction (used pre-popup) ─────────────────────────────

const NAME_EXTRACT_SCHEMA = z.object({
  speakers: z
    .array(
      z.object({
        label: z.string(),
        name: z.string().min(1),
      })
    )
    .default([]),
});

const NAME_EXTRACT_SYSTEM = `You are extracting speaker names from a meeting
transcript. Each line is prefixed with a generic label like "Speaker 1",
"Speaker 2", etc.

Some speakers may introduce themselves by name. The introduction can be in
ANY language — English ("Hi, I'm Alex", "Hello, this is Sarah"), Bangla
("ami Rakib bolchi", "amar nam Tareq"), Bangla-English code-switch ("Hello
everyone, ami Shahriar"), or anything else.

Return a JSON object with one field, "speakers", an array of
{ "label": "Speaker N", "name": "<the name>" } objects. The "label" MUST
be the exact string used in the transcript (e.g. "Speaker 1"). The "name"
should be just the person's first name unless they clearly state a fuller
form.

Rules:
  - Only include speakers whose self-introduction is unambiguous.
  - Never invent names. If you're guessing, leave them out.
  - Empty "speakers" array is the correct answer when nobody self-introduces.

Reply with ONLY a JSON object. No prose. No markdown code fences.`;

/**
 * Tiny LLM call to pull self-introduced names out of a short named
 * transcript. Used in identify-speakers so the Speaker Naming Popup
 * arrives pre-filled (the user sees "Alex" in the input rather than a
 * blank field they have to fill themselves).
 *
 * Returns an empty array on any failure — failing to extract is fine
 * (the popup still works, just without pre-fill). /process runs the
 * full summarize call later and does its own extraction as a fallback.
 */
export async function extractSpeakerNames(
  namedTranscript: string
): Promise<Array<{ label: string; name: string }>> {
  let raw: string;
  try {
    raw = await complete({
      system: NAME_EXTRACT_SYSTEM,
      user: `Transcript:\n\n${namedTranscript}\n\nReturn the JSON object.`,
      maxTokens: 300,
    });
  } catch (err) {
    console.warn("[extractSpeakerNames] LLM call failed:", err);
    return [];
  }

  try {
    const json = JSON.parse(stripCodeFences(raw));
    const parsed = NAME_EXTRACT_SCHEMA.parse(json);
    return parsed.speakers.map((s) => ({
      label: s.label.trim(),
      name: s.name.trim(),
    }));
  } catch (err) {
    console.warn("[extractSpeakerNames] failed to parse LLM output:", err);
    return [];
  }
}

// Some prompts cause models to wrap JSON in ```json fences despite instructions.
function stripCodeFences(s: string): string {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return s.trim();
}
