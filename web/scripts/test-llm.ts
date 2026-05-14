/**
 * Smoke test for the LLM summary path. Confirms the active provider key,
 * endpoint, and JSON parsing all work end-to-end.
 *
 * Run: npx tsx scripts/test-llm.ts
 */
import { summarizeTranscript } from "../lib/llm";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env.local" });

const TRANSCRIPT = `Sarah: Welcome everyone. Today we need to decide on the Q3 launch date.
Mike: I think Friday is too aggressive given the bug count.
Sarah: What about the Monday after? That gives us a clean week of QA.
Mike: Works for me. I'll own the regression test pass.
Sarah: Great. Let's also confirm we're pulling the dark mode feature out of scope.
Mike: Agreed, it's not blocking anything else and shipping later is fine.
Sarah: Done. I'll send the updated launch plan by EOD.`;

async function main() {
  console.log(`→ provider:`, process.env.LLM_PROVIDER || "openrouter");
  console.log(`→ calling summarizeTranscript with ${TRANSCRIPT.length}-char transcript…`);

  const start = Date.now();
  const result = await summarizeTranscript(TRANSCRIPT);
  const ms = Date.now() - start;

  console.log(`✓ got summary in ${ms} ms`);
  console.log(`\n--- summary ---`);
  console.log(result.summary);
  console.log(`\n--- action items (${result.actionItems.length}) ---`);
  for (const a of result.actionItems) {
    console.log(`  • ${a.text}${a.owner ? ` (${a.owner})` : ""}${a.dueDate ? ` — ${a.dueDate}` : ""}`);
  }
  console.log(`\n--- decisions (${result.decisions.length}) ---`);
  for (const d of result.decisions) {
    console.log(`  • ${d.text}${d.rationale ? ` — ${d.rationale}` : ""}`);
  }
  console.log(`\n--- topics (${result.topics.length}) ---`);
  for (const t of result.topics) {
    console.log(`  • ${t.name}${t.summary ? `: ${t.summary}` : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
