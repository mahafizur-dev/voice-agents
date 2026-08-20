// Deploys the 4 department agents + the squad (workflow) that routes between them,
// and optionally attaches the squad to a Vapi phone number.
//
// Idempotent: assistant/squad IDs from a previous run are cached in
// config/.deployed.json and reused via PATCH instead of creating duplicates.
//
// Usage:
//   npm run deploy
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const VAPI_BASE = "https://api.vapi.ai";
const ROOT = path.join(__dirname, "..");
const AGENTS_DIR = path.join(ROOT, "config", "agents");
const WORKFLOW_PATH = path.join(ROOT, "config", "workflow.json");
const STATE_PATH = path.join(ROOT, "config", ".deployed.json");

const AGENT_FILES = [
  "general-support.json",
  "billing.json",
  "technical-support.json",
  "orders-returns.json",
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }
  return { agents: {}, squadId: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// Replaces ${VAR} tokens anywhere in the JSON text with values from process.env
// before parsing, so config files stay readable templates instead of hardcoded copy.
function loadTemplatedJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const filled = raw.replace(/\$\{(\w+)\}/g, (match, name) => {
    if (process.env[name] === undefined) {
      console.warn(`Warning: ${path.basename(filePath)} references \${${name}} which is not set in .env`);
      return match;
    }
    return process.env[name];
  });
  return JSON.parse(filled);
}

async function vapiRequest(apiKey, method, urlPath, body) {
  const res = await fetch(`${VAPI_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const apiKey = requireEnv("VAPI_PRIVATE_KEY");
  const state = loadState();

  const webhookUrl = process.env.WEBHOOK_URL; // e.g. https://your-tunnel.ngrok.app/vapi/webhook
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;
  if (!webhookUrl) {
    console.warn("WEBHOOK_URL not set in .env — assistants will deploy without call logging wired up.");
  }

  // 1. Deploy the 4 agents
  const idsByName = {};
  for (const file of AGENT_FILES) {
    const config = loadTemplatedJson(path.join(AGENTS_DIR, file));

    if (webhookUrl) {
      config.server = { url: webhookUrl, secret: webhookSecret || undefined };
      config.serverMessages = ["end-of-call-report"];
    }

    const existingId = state.agents[config.name];
    let result;
    if (existingId) {
      console.log(`Updating assistant "${config.name}" (${existingId})...`);
      result = await vapiRequest(apiKey, "PATCH", `/assistant/${existingId}`, config);
    } else {
      console.log(`Creating assistant "${config.name}"...`);
      result = await vapiRequest(apiKey, "POST", "/assistant", config);
    }
    state.agents[config.name] = result.id;
    idsByName[config.name] = result.id;
    console.log(`  -> ${result.id}`);
    saveState(state);
  }

  // 2. Build and deploy the squad (workflow) that ties them together
  const workflow = loadTemplatedJson(WORKFLOW_PATH);
  const memberNames = AGENT_FILES.map((f) => loadTemplatedJson(path.join(AGENTS_DIR, f)).name);

  const members = memberNames.map((name) => {
    const destinations = workflow.routes
      .filter((r) => r.from === name)
      .map((r) => ({
        type: "assistant",
        assistantName: r.to,
        message: r.message,
        description: r.condition,
      }));
    return {
      assistantId: idsByName[name],
      assistantDestinations: destinations,
    };
  });

  const squadPayload = { name: workflow.name, members };

  let squad;
  if (state.squadId) {
    console.log(`Updating squad "${workflow.name}" (${state.squadId})...`);
    squad = await vapiRequest(apiKey, "PATCH", `/squad/${state.squadId}`, squadPayload);
  } else {
    console.log(`Creating squad "${workflow.name}"...`);
    squad = await vapiRequest(apiKey, "POST", "/squad", squadPayload);
  }
  state.squadId = squad.id;
  saveState(state);
  console.log(`  -> squad ${squad.id} (entry point: ${workflow.entryAgent})`);

  // 3. Optionally attach the squad to a phone number
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  if (phoneNumberId) {
    console.log(`Attaching squad to phone number ${phoneNumberId}...`);
    await vapiRequest(apiKey, "PATCH", `/phone-number/${phoneNumberId}`, { squadId: squad.id });
    console.log("  -> done");
  } else {
    console.log("VAPI_PHONE_NUMBER_ID not set — skipping phone number attachment.");
    console.log("Buy/import a number in the Vapi dashboard, then set VAPI_PHONE_NUMBER_ID and re-run deploy,");
    console.log(`or attach squadId ${squad.id} to a number manually.`);
  }

  console.log("\nDeployed:");
  for (const [name, id] of Object.entries(state.agents)) console.log(`  ${name}: ${id}`);
  console.log(`  Squad: ${state.squadId}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
