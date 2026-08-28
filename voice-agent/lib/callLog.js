// Persists logged calls to an Upstash Redis list ("calls") over its REST API,
// so call history survives redeploys on hosts with no persistent disk (e.g.
// Render's free tier). Read by server/webhook.js (append) and
// scripts/review-calls.js (read back for the review report).
//
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (from the
// Upstash console: your database -> REST API section).
const MAX_CALLS = 5000;

function restUrl() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set (see .env.example)");
  }
  return { url, token };
}

async function appendCall(record) {
  const { url, token } = restUrl();
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify([
      ["RPUSH", "calls", JSON.stringify(record)],
      ["LTRIM", "calls", -MAX_CALLS, -1],
    ]),
  });
  if (!res.ok) throw new Error(`Upstash pipeline failed: ${res.status} ${await res.text()}`);
}

async function listCalls(limit) {
  const { url, token } = restUrl();
  const start = limit ? -limit : 0;
  const res = await fetch(`${url}/lrange/calls/${start}/-1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Upstash lrange failed: ${res.status} ${await res.text()}`);
  const { result } = await res.json();
  return result.map((line) => JSON.parse(line));
}

module.exports = { appendCall, listCalls };
