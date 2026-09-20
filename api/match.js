// Ranks dishes against a free-text request using Jev (TypeSafe System One) via Vercel AI Gateway.
// The API key is read server-side only and never reaches the browser.

const ENDPOINT = process.env.AI_GATEWAY_URL || 'https://ai-gateway.vercel.sh/v1/evaluate';
const MODEL = process.env.JEV_MODEL || 'typesafe-ai/jev';
const THRESHOLD = Number(process.env.MATCH_THRESHOLD) || 0.5;
const RULE =
  'a dish fits if it answers the request, honouring any constraint on ingredients, effort, ' +
  'diet or nutrition. If the request excludes something, a dish containing it does not fit.';

// Strips quantities: "60g oats · 200ml milk" -> "oats, milk". Amounts never affect a match.
const ingredients = how => how
  .split('·')
  .map(p => p.trim().replace(/^[\d./]+\s*(g|kg|ml|l|tbsp|tsp|cups?|slices?|scoops?)?\s*/i, ''))
  .filter(Boolean)
  .join(', ');

// Flat lines, not nested JSON: same information at ~4 chars/token instead of ~2.5.
const line = d => {
  const parts = [d.id, d.name, `${d.kcal}kcal ${d.p}g protein ${d.mins}min ${d.diet} ${d.slot}`];
  if (d.how) parts.push(ingredients(d.how));
  return parts.join(' | ');
};

export async function match(query, dishes, key) {
  const state = `REQUEST: ${query}\n\nRULE: ${RULE}\n\nDISHES (id | name | facts | ingredients):\n`
    + dishes.map(line).join('\n');

  // One request: every question is answered in parallel against the same state.
  const questions = Object.fromEntries(
    dishes.map(d => [d.id, { type: 'boolean', instructions: `Does ${d.id} fit?` }])
  );

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 180)}`);

  const { answers = {}, usage, model, providerMetadata } = await res.json();
  const scores = {};
  for (const [id, a] of Object.entries(answers)) scores[id] = a.probability ?? 0;
  return { scores, threshold: THRESHOLD, usage, model, cost: providerMetadata?.gateway?.cost };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const key = process.env.AI_GATEWAY_API_KEY;
  // No key or a bad gateway is not fatal: the client falls back to its offline rules.
  if (!key) return res.status(503).json({ error: 'no_key', fallback: true });

  const { query, dishes } = req.body ?? {};
  if (!query || !Array.isArray(dishes) || !dishes.length) {
    return res.status(400).json({ error: 'bad_request' });
  }

  try {
    return res.status(200).json(await match(query, dishes, key));
  } catch (err) {
    return res.status(502).json({ error: String(err.message ?? err), fallback: true });
  }
}
