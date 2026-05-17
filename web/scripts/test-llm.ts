/**
 * Smoke test for the LLM summary path. Confirms the active provider key,
 * endpoint, and JSON parsing all work end-to-end.
 *
 * Run: npx tsx scripts/test-llm.ts
 */
import { summarizeTranscript } from "../lib/llm";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

// A transcript where speakers self-introduce — one in English, one mid-code-
// switch Bangla+English. Tests both the Result-Card extraction and the new
// speaker_names binding.
const TRANSCRIPT = `Speaker 1: Hi everyone, I'm Alex. Thanks for joining today.
Speaker 2: Hello, ami Rakib bolchi. Ajke amader meeting is on the Q3 launch.
Speaker 1: Right. I think Friday is too aggressive given the bug count.
Speaker 2: What about the Monday after? That gives us a clean week of QA.
Speaker 1: Works for me. I'll own the regression test pass.
Speaker 2: Done. I'll send the updated launch plan by EOD.`;

async function main() {
  console.log(`→ provider:`, process.env.LLM_PROVIDER || "openrouter");
  console.log(`→ calling summarizeTranscript with ${TRANSCRIPT.length}-char transcript…`);

  const start = Date.now();
  const result = await summarizeTranscript(TRANSCRIPT);
  const ms = Date.now() - start;

  console.log(`✓ got result in ${ms} ms`);
  console.log(`\n--- next step ---`);
  console.log(result.nextStep ?? "(none)");
  console.log(`\n--- summary ---`);
  console.log(result.summary);
  console.log(`\n--- decisions (${result.decisions.length}) ---`);
  for (const d of result.decisions) {
    console.log(`  • ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`);
  }
  console.log(`\n--- action items (${result.actionItems.length}) ---`);
  for (const a of result.actionItems) {
    console.log(`  • ${a.text}${a.owner ? ` (${a.owner})` : ""}${a.dueDate ? ` — ${a.dueDate}` : ""}`);
  }
  console.log(`\n--- open questions (${result.openQuestions.length}) ---`);
  for (const q of result.openQuestions) {
    console.log(`  • ${q.text}`);
  }
  console.log(`\n--- speaker names (${result.speakerNames.length}) ---`);
  for (const sn of result.speakerNames) {
    console.log(`  • ${sn.label.padEnd(12)} → ${sn.name}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
