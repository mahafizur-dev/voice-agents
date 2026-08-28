// Turns logged calls (stored in Upstash Redis by server/webhook.js, see
// lib/callLog.js) into a report of where each agent is struggling, so a human
// can update the prompts in config/agents/*.json. This is the "learning
// loop": nothing here retrains a model, it just makes recurring failure
// patterns visible fast.
//
// Usage:
//   npm run review              (last 7 days, all agents)
//   npm run review -- --days 30
//   npm run review -- --agent "Billing & Payments"
require("dotenv").config();
const { listCalls } = require("../lib/callLog");

const PROBLEM_ENDED_REASONS = new Set([
  "assistant-error",
  "pipeline-error-openai-llm-failed",
  "pipeline-error-vapi-llm-failed",
  "pipeline-error-transcriber-failed",
  "pipeline-error-vapi-voice-failed",
  "silence-timed-out",
  "exceeded-max-duration",
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { days: 7, agent: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") out.days = Number(args[++i]);
    if (args[i] === "--agent") out.agent = args[++i];
  }
  return out;
}

async function main() {
  const { days, agent } = parseArgs();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let calls = (await listCalls()).filter((c) => {
    const t = c.loggedAt ? Date.parse(c.loggedAt) : 0;
    return t >= cutoff;
  });
  if (agent) calls = calls.filter((c) => c.assistantName === agent);

  if (calls.length === 0) {
    console.log(`No calls logged in the last ${days} day(s)${agent ? ` for "${agent}"` : ""}.`);
    console.log("(Nothing here until server/webhook.js is running, reachable via WEBHOOK_URL, and has received real calls.)");
    return;
  }

  const byAgent = {};
  for (const c of calls) {
    const name = c.assistantName || "(unknown agent)";
    byAgent[name] ??= { total: 0, problems: [], flaggedUnsuccessful: [], durations: [] };
    byAgent[name].total++;
    if (typeof c.durationSeconds === "number") byAgent[name].durations.push(c.durationSeconds);
    if (PROBLEM_ENDED_REASONS.has(c.endedReason)) byAgent[name].problems.push(c);

    const se = c.successEvaluation;
    const looksUnsuccessful =
      se === false || se === "false" || (typeof se === "string" && /^(no|fail|unsuccessful)/i.test(se.trim()));
    if (looksUnsuccessful) byAgent[name].flaggedUnsuccessful.push(c);
  }

  console.log(`\n=== Call review: last ${days} day(s), ${calls.length} call(s) ===\n`);

  for (const [name, stats] of Object.entries(byAgent)) {
    const avgDuration = stats.durations.length
      ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length)
      : null;

    console.log(`--- ${name} ---`);
    console.log(`  calls: ${stats.total}${avgDuration !== null ? `, avg duration: ${avgDuration}s` : ""}`);
    console.log(`  technical/pipeline problems: ${stats.problems.length}`);
    console.log(`  flagged unsuccessful by call analysis: ${stats.flaggedUnsuccessful.length}`);

    const toReview = [...stats.problems, ...stats.flaggedUnsuccessful].slice(0, 5);
    if (toReview.length) {
      console.log("  sample calls to review:");
      for (const c of toReview) {
        console.log(`    - call ${c.callId ?? "?"} [${c.endedReason ?? "?"}]: ${c.summary ?? "(no summary captured)"}`);
      }
    }
    console.log("");
  }

  console.log("Next step: read the flagged transcripts for these call IDs (GET /vapi/logs on the");
  console.log("webhook server, or fetch them from Upstash directly), look for a shared pattern (a");
  console.log("question the agent keeps mishandling, a missing policy detail, a transfer that should");
  console.log("have happened earlier), and update the matching prompt in config/agents/*.json, then");
  console.log("`npm run deploy` again.\n");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
