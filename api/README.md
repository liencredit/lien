# LIEN `/api`

Backend for LIEN — the credit bureau for autonomous AI agents. Reads an agent's
8004 reputation, (soon) scores it, and serves the REST API in `../LIEN-docs.md`.

See `../LIEN_CONTEXT.md` for the full product context and build order.

## Stack

- Node 20+ / TypeScript (ESM)
- Fastify (HTTP) + Zod (validation)
- Reads 8004 via Quantu's verified indexer GraphQL — no raw event streams.

## Setup

```bash
cp .env.example .env   # defaults already point at devnet
npm install
```

## Scripts

| Command | What |
|---|---|
| `npm run dev` | Run the server with hot reload (`tsx watch`). |
| `npm run spike` | Read spike against the live 8004 indexer (proves the reader works). |
| `npm test` | Run the scoring engine unit tests (`node:test`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | Compile to `dist/`. |
| `npm start` | Run the compiled server. |

## Current surface

The core REST API (per `../LIEN-docs.md`), served from the Store:

- `GET  /health`
- `GET  /v1/score/:agent_id` — `credit_score` (computes + persists on first read)
- `GET  /v1/report/:agent_id` — `report` (score + identity + factors + settlements)
- `GET  /v1/registry?sort=&status=&limit=&starting_after=` — paginated `credit_score` list
- `POST /v1/settlements` — record an outcome (idempotent via `Idempotency-Key`)
- `POST /v1/attest/:agent_id` — validate the agent's `feedback_auth` and write the
  score back. The external write is delegated to an `AttestationWriter` (noop until
  `LIEN_SIGNER_SECRET` + `LIEN_SCORE_PROGRAM_ID` are set); `attested` reflects
  whether a real write happened.

Auth: set `LIEN_API_KEY` to require `Authorization: Bearer <key>`; unset = open (dev).

Webhooks: set `LIEN_WEBHOOK_URL` + `LIEN_WEBHOOK_SECRET` (or `LIEN_WEBHOOKS` JSON) to
receive signed events (`score.updated`, `agent.defaulted`, `agent.recovered`,
`attestation.written`). Each delivery carries a `LIEN-Signature` header (HMAC SHA-256
of the body) — verify it with `Lien.webhooks.constructEvent` from `@lien/sdk`.

Debug passthroughs (read 8004 directly, bypassing storage):

- `GET /v1/_8004/stats`, `GET /v1/_8004/agent/:id`, `GET /v1/_8004/agent/:id/feedback`

## Storage & seed

Storage is behind a backend-agnostic `Store` interface (`src/storage/`). It is
in-memory by default and **Supabase-backed when `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`
are set** (PostgREST, no SDK dependency). Both satisfy the same contract and share
the sort/cursor logic in `query.ts`.

To use Supabase (e.g. the same project your Lovable frontend uses):

1. Apply `../db/schema.sql` in the Supabase SQL editor.
2. Set `SUPABASE_URL` (the project URL) and `SUPABASE_SERVICE_KEY` (service-role key
   from dashboard → Project Settings → API — not the anon key) in `.env`.
3. Usually set `LIEN_SEED=false` so synthetic agents don't land in the real DB.

On boot (`LIEN_SEED=true`, default) the store is loaded with deterministic synthetic
agents (all flagged `synthetic: true`) so the registry looks alive. Never present
seeded numbers as real live metrics.

## Layout

```
src/
  config.ts            cluster + endpoint resolution
  server.ts            Fastify app
  index.ts             entry point
  registry/
    graphql.ts         minimal GraphQL-over-HTTP client
    reader.ts          RegistryReader: resolveAgent / getFeedback / listAgents
    types.ts           verified 8004 shapes
  scoring/
    types.ts           ScoringInput / Factor / ScoreResult
    engine.ts          computeScore — pure, deterministic
    derive.ts          RawAgent + feedback (+ ledger) -> ScoringInput
    engine.test.ts     unit tests / fixtures
  storage/
    types.ts           Store interface + domain records
    query.ts           shared sort + cursor pagination
    memory.ts          in-memory Store
    supabase.ts        Supabase/PostgREST Store + row mappers
    index.ts           createStore() factory (memory | supabase)
    store.test.ts      storage + seed + ledger tests
    supabase.test.ts   row mapping + request tests
  service/
    scoring-service.ts read 8004 -> fold ledger -> score -> persist -> emit events
    attestation.ts     feedback_auth validation + AttestationWriter
    webhooks.ts        signed event dispatch (HMAC) + retry transport
  api/
    routes.ts          /v1 endpoints
    serializers.ts     record -> public API object
    errors.ts          typed error responses
  seed/
    data.ts            deterministic synthetic agents (synthetic: true)
scripts/
  spike.ts             live read spike
```

## 8004 endpoints (verified live 2026-06)

- Devnet: `https://8004-indexer-dev.qnt.sh/v2/graphql`
- Mainnet: `https://8004-indexer-main.qnt.sh/v2/graphql`

The bare `8004.qnt.sh/v2/graphql` path from older docs 404s — use the indexer
subdomains above.
