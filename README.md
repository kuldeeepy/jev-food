# jev-food

Pick a meal by rummaging through a heap of them.

76 dishes sit in a physics heap in the grass. Ask for something and the matches rise out of
it and line up, labelled and ranked by relevance. Built because a grid of 76 dishes is a
list you scroll past, while a heap is a bounded set you can actually rummage through.

## Running it

```bash
cp .env.example .env.local   # add your Vercel AI Gateway key
npm run dev                  # http://localhost:8099
```

`dev.js` serves `public/` and runs the `/api/match` function that Vercel hosts in
production, so local behaves like deployed.

## How matching works

Two paths, in order:

1. **Jev** (`typesafe-ai/jev` through Vercel AI Gateway). All 76 dishes go up as a single
   request and come back as calibrated probabilities, which double as the ranking. It
   handles negation (`no onion`), inference (`something spicy`, where no dish records
   spice) and typos. About 3.5k input tokens, roughly $0.00015 a search.
2. **Local rules.** Regex intents over the dish fields, used whenever Jev is unreachable,
   keyless, rate limited or slow, so the page keeps working offline. Noticeably dumber: it
   cannot do negation and returns the opposite for `not chicken`.

Identical queries are cached in memory, so repeats and chips cost nothing.

## Configuration

Everything tunable is an environment variable or lives in the `CFG` block at the top of
`public/pile.js`. No magic numbers buried in the code.

| Variable | Default | Purpose |
|---|---|---|
| `AI_GATEWAY_API_KEY` | none | Gateway key. Required for Jev, otherwise the rules run. |
| `AI_GATEWAY_URL` | `https://ai-gateway.vercel.sh/v1/evaluate` | Gateway endpoint. |
| `JEV_MODEL` | `typesafe-ai/jev` | Evaluation model. |
| `MATCH_THRESHOLD` | `0.5` | Probability floor below which a dish is not a match. |
| `PORT` | `8099` | Dev server port. |

## The key

`AI_GATEWAY_API_KEY` is read **server side only**, in `api/match.js`. It never reaches the
browser, which is the whole reason the function exists rather than calling the gateway
straight from the page. Without a key the API returns `503 {fallback:true}` and the client
quietly uses the rules.

## Data

`public/dishes.json` carries 76 dishes. Each has one or two emoji: pairs exist because no
single glyph says "paneer bhurji with roti", and they give 76 distinct signatures where
single emoji gave 57.

22 dishes come from a personal meal rotation and carry real macros. The other 54 are
tagged `demo: true`, use approximate public nutrition values, and are labelled as such in
the interface.

## Credits

Hero illustration from the [Visual Vault](https://www.figma.com/community) pack by Ameer
Talha. Check its terms before reusing.
