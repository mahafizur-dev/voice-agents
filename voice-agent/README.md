# Voice Agents — Inbound Support (4 departments)

Four Vapi voice agents for one business's inbound support line, connected by a
routing workflow, with a call-logging loop that stands in for "the AI keeps
improving over time."

## Architecture

```
inbound call
     |
     v
[ General Support ]  <-- entry point / triage
     |         \            \
     v          v             v
[ Billing ]  [ Technical ]  [ Orders & Returns ]
     ^____________|______________|
     (each can transfer back to General Support, or sideways
      to another department, if the issue turns out to belong there)
```

- Each box is a separate **Vapi Assistant** with its own system prompt, voice,
  and behavior — see `config/agents/*.json`.
- The connections are a **Vapi Squad** (Vapi's mechanism for multi-assistant
  calls with live transfers) — defined declaratively in `config/workflow.json`
  and turned into a real squad by `scripts/deploy.js`.
- Every finished call is POSTed by Vapi to `server/webhook.js`, which appends
  a structured record to an Upstash Redis list (see `lib/callLog.js`), so
  history survives redeploys on hosts with no persistent disk.
- `scripts/review-calls.js` reads that log and surfaces calls worth listening
  to — pipeline errors, calls flagged unsuccessful by Vapi's own call
  analysis — so you can fix the prompt that's causing repeat failures.

### Important honesty note on "AI will continue to learn and improve over time"

The underlying model (GPT-4o via Vapi) does not retrain itself on your calls.
"Improves over time" here means: real transcripts get logged, a recurring
review surfaces where an agent is failing, you edit that agent's prompt in
`config/agents/*.json`, and redeploy. That loop is real and this repo
automates the logging + surfacing half of it — the prompt edits stay a human
decision, which is also what you want for a support line (you don't want an
agent quietly rewriting its own policies).

## 1. Accounts / keys you need

| What | Why | Where to get it |
|---|---|---|
| Vapi account + private API key | Hosts the assistants, squad, voice/telephony pipeline | https://dashboard.vapi.ai → Settings → API Keys |
| A phone number | So people can actually call in | Buy inside Vapi dashboard (Twilio-backed), or import an existing Twilio number under Phone Numbers |
| OpenAI key | Vapi can use its own bundled key, or you can bring your own for cost control | Optional — only needed if you want to use your own OpenAI billing instead of Vapi's pass-through |
| ElevenLabs voice IDs (optional) | The 4 configs use 4 distinct default ElevenLabs voices; swap `voiceId` in each `config/agents/*.json` for your own picks | https://elevenlabs.io/app/voice-library |
| A public URL for webhooks | So Vapi can POST call reports to `server/webhook.js` | `ngrok http 8787` while developing; a real deployed URL in production |

You do **not** need Twilio directly unless you want to import a number you
already own elsewhere — Vapi can provision one for you.

## 2. Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:
- `VAPI_PRIVATE_KEY` — from the Vapi dashboard.
- `COMPANY_NAME`, `COMPANY_HOURS`, `SUPPORT_EMAIL` — injected into every
  agent's prompt via `${COMPANY_NAME}`-style tokens in the config files.
- `WEBHOOK_URL` — public URL for `server/webhook.js` (see below). Leave blank
  to deploy without call logging for now.
- `VAPI_WEBHOOK_SECRET` — any random string; verifies incoming webhooks are
  actually from Vapi.
- `VAPI_PHONE_NUMBER_ID` — leave blank until you've bought/imported a number
  in the Vapi dashboard, then paste its ID here.

## 3. Run the webhook server and expose it

```bash
npm run webhook
```

In another terminal, tunnel it (or point `WEBHOOK_URL` at wherever you
actually deploy this):

```bash
ngrok http 8787
```

Copy the `https://...ngrok.app` URL into `WEBHOOK_URL` in `.env` as
`https://xxxx.ngrok.app/vapi/webhook`.

## 4. Deploy the agents + workflow

```bash
npm run deploy
```

This creates (or updates, if run again) the 4 assistants and the squad that
connects them, and — if `VAPI_PHONE_NUMBER_ID` is set — attaches the squad to
your phone number so inbound calls land on General Support and get routed
from there. IDs are cached in `config/.deployed.json` so re-running `deploy`
after editing a prompt updates the existing assistant instead of creating a
duplicate.

## 5. Call it

Call the number attached to the squad. General Support answers first; ask
about a charge, a login error, or an order to hear it transfer you.

## 6. Review calls and improve prompts

```bash
npm run review               # last 7 days
npm run review -- --days 30
npm run review -- --agent "Technical Support"
```

Read the flagged transcripts (printed inline, or `GET /vapi/logs` on the
webhook server — see below), find the pattern, edit the relevant
`config/agents/*.json` prompt, then `npm run deploy` again.

## File map

```
config/agents/*.json     4 assistant definitions (prompt, voice, transcriber)
config/workflow.json     routing rules between the 4 agents (-> Vapi squad)
config/.deployed.json    generated: assistant/squad IDs, so redeploys update in place
scripts/deploy.js        creates/updates assistants + squad + phone number attachment
server/webhook.js        receives Vapi end-of-call-report webhooks, logs calls via lib/callLog.js
lib/callLog.js           shared Upstash Redis read/write helpers for the call log
scripts/review-calls.js  turns the call log into a "what to fix" report
```

## Remote log access

`GET /vapi/logs?token=<LOGS_TOKEN>&limit=20` on the webhook server returns the
most recently logged calls as JSON — useful when the host has no direct
filesystem/shell access. Set `LOGS_TOKEN` in `.env` to enable it (disabled by
default); pass the token via `?token=` or an `x-logs-token` header.

## Customizing further

- **Tone/policy per department**: edit the `model.messages[0].content` system
  prompt in the relevant `config/agents/*.json` file.
- **Add real actions** (look up an order, check billing status, actually
  process a refund): add a `tools`/function-calling section to the relevant
  assistant config that calls your backend/CRM API, and update that agent's
  prompt to reference it. Right now the agents are conversation-only — they
  explicitly avoid claiming to have done something they can't actually do.
- **Add a 5th department or change routing**: add a new file under
  `config/agents/`, add it to `AGENT_FILES` in `scripts/deploy.js`, and add
  its transfer conditions to `config/workflow.json`.
