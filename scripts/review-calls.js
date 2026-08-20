// Turns logged calls (data/calls.jsonl, written by server/webhook.js) into a
// report of where each agent is struggling, so a human can update the prompts
// in config/agents/*.json. This is the "learning loop": nothing here retrains
// a model, it just makes recurring failure patterns visible fast.
//
// Usage:
//   npm run review              (last 7 days, all agents)
//   npm run review -- --days 30
//   npm run review -- --agent "Billing & Payments"
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "..", "data", "calls.jsonl");

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

function loadCalls() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs
    .readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function main() {
  const { days, agent } = parseArgs();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  let calls = loadCalls().filter((c) => {
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

  console.log("Next step: read the flagged transcripts in data/calls.jsonl for these call IDs,");
  console.log("look for a shared pattern (a question the agent keeps mishandling, a missing policy detail,");
  console.log("a transfer that should have happened earlier), and update the matching prompt in");
  console.log("config/agents/*.json, then `npm run deploy` again.\n");
}

main();
