import "dotenv/config";
import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const APP_TOKEN = process.env.APP_TOKEN || ""; // shared secret the Android app sends

if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY in environment.");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1); // correct client IP behind Render/Railway
app.use(cors());
app.use(express.json({ limit: "200kb" }));

// ---------- simple auth + per-IP rate limit (in-memory) ----------
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;

function guard(req, res, next) {
  if (APP_TOKEN && req.get("x-app-token") !== APP_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const ip = req.ip;
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    return res.status(429).json({ error: "slow down" });
  }
  recent.push(now);
  hits.set(ip, recent);
  next();
}

// ---------- prompt ----------
const ALLOWED_ACTIONS = ["tap", "type", "scroll_down", "scroll_up", "back", "wait", "done"];

const SYSTEM_PROMPT = `You control an Android phone to apply for jobs on behalf of a user, inside the Indeed app.
You are given: the user's profile, the goal, the recent action history, and the current screen as a list of UI nodes.
Each node has: id (number), text, desc, clickable (bool), editable (bool).

Pick exactly ONE next action. Respond with JSON only, in this shape:
{"action":"tap|type|scroll_down|scroll_up|back|wait|done","nodeId":<number or null>,"text":<string or null>,"reason":"<short>"}

Rules:
- "tap": set nodeId to a clickable node.
- "type": set nodeId to an editable node and text to the value to enter, using ONLY facts from the profile or screening answers. Never invent experience, degrees, or work authorization.
- If a required question has no answer in the profile, respond {"action":"done","nodeId":null,"text":null,"reason":"needs_user_input: <the question>"}.
- Prefer jobs matching the profile's target roles and location. Skip jobs requiring external sites or account creation.
- Use "done" when the application is submitted or the goal is complete.
- Do not repeat an action that already failed in the history; try something different.
- Output JSON only, no markdown.`;

// ---------- helpers ----------
function sanitizeNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.slice(0, 120).map((n) => ({
    id: n.id,
    text: String(n.text ?? "").slice(0, 160),
    desc: String(n.desc ?? "").slice(0, 100),
    clickable: !!n.clickable,
    editable: !!n.editable,
  }));
}

function parseAction(raw) {
  try {
    const cleaned = String(raw).replace(/```json|```/g, "").trim();
    const obj = JSON.parse(cleaned);
    if (!ALLOWED_ACTIONS.includes(obj.action)) throw new Error("bad action");
    return {
      action: obj.action,
      nodeId: Number.isInteger(obj.nodeId) ? obj.nodeId : null,
      text: typeof obj.text === "string" ? obj.text : null,
      reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "",
    };
  } catch {
    return { action: "wait", nodeId: null, text: null, reason: "unparseable model output" };
  }
}

async function callGroq(messages, useJsonMode) {
  const body = {
    model: GROQ_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 1000,
  };
  if (GROQ_MODEL.includes("gpt-oss")) body.reasoning_effort = "low";
  if (useJsonMode) body.response_format = { type: "json_object" };

  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function askGroq(messages) {
  let r = await callGroq(messages, true);
  // If the model/endpoint rejects JSON mode, retry once without it.
  if (r.status === 400) r = await callGroq(messages, false);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Groq ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- routes ----------
app.get("/health", (_req, res) => res.json({ ok: true, model: GROQ_MODEL }));

/**
 * POST /next-action
 * body: {
 *   goal: "Apply to Junior Data Analyst jobs in Austin",
 *   profile: { name, email, phone, location, targetRoles, resumeSummary, answers: {...} },
 *   history: [{ action, nodeId, text, result }],
 *   screen: [{ id, text, desc, clickable, editable }]
 * }
 */
app.post("/next-action", guard, async (req, res) => {
  try {
    const { goal, profile, history, screen } = req.body || {};
    if (!goal || !Array.isArray(screen)) {
      return res.status(400).json({ error: "goal and screen are required" });
    }

    const userPayload = {
      goal: String(goal).slice(0, 300),
      profile: profile || {},
      history: Array.isArray(history) ? history.slice(-10) : [],
      screen: sanitizeNodes(screen),
    };

    const raw = await askGroq([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) },
    ]);

    res.json(parseAction(raw));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ action: "wait", nodeId: null, text: null, reason: "backend error" });
  }
});

app.listen(PORT, () => console.log(`JobAgent backend on :${PORT} (${GROQ_MODEL})`));
