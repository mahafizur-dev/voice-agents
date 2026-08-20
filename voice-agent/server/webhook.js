// Receives Vapi server-side webhooks (configured via each assistant's `server.url`)
// and appends a structured record per finished call to data/calls.jsonl.
// That log is the raw material scripts/review-calls.js mines to find where the
// agents are failing, which is how these agents "improve over time" in practice —
// voice LLMs don't retrain themselves; improvement means periodically reading
// real transcripts and updating the prompts in config/agents/*.json.
//
// Usage:
//   npm run webhook
// Then expose it publicly (e.g. `ngrok http 8787`) and set WEBHOOK_URL in .env
// to https://<your-tunnel>/vapi/webhook before running `npm run deploy`.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");

const DATA_DIR = path.join(__dirname, "..", "data");
const LOG_PATH = path.join(DATA_DIR, "calls.jsonl");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "5mb" }));

app.post("/vapi/webhook", (req, res) => {
  const expectedSecret = process.env.VAPI_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.header("x-vapi-secret");
    if (got !== expectedSecret) {
      console.warn("Rejected webhook: bad or missing x-vapi-secret header");
      return res.status(401).send("unauthorized");
    }
  }

  const message = req.body?.message;
  if (!message) return res.status(400).send("missing message");

  // Acknowledge immediately; Vapi doesn't need us to finish processing to get a 200.
  res.status(200).send("ok");

  if (message.type !== "end-of-call-report") return;

  try {
    const record = {
      loggedAt: new Date().toISOString(),
      callId: message.call?.id ?? null,
      assistantId: message.call?.assistantId ?? message.assistant?.id ?? null,
      assistantName: message.assistant?.name ?? null,
      endedReason: message.endedReason ?? null,
      startedAt: message.startedAt ?? null,
      endedAt: message.endedAt ?? null,
      durationSeconds: message.durationSeconds ?? null,
      cost: message.cost ?? null,
      summary: message.analysis?.summary ?? null,
      successEvaluation: message.analysis?.successEvaluation ?? null,
      transcript: message.artifact?.transcript ?? message.transcript ?? null,
    };
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
    console.log(`Logged call ${record.callId ?? "(no id)"} -> ${record.assistantName ?? "unknown agent"}`);
  } catch (err) {
    console.error("Failed to log call:", err.message);
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

const port = process.env.WEBHOOK_PORT || 8787;
app.listen(port, () => console.log(`Webhook server listening on :${port} (POST /vapi/webhook)`));
