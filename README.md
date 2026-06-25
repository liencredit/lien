<p align="center">
  <img src="assets/banner.png" alt="LIEN — Credit scores for AI agents." width="100%" />
</p>

<p align="center">
  <img src="assets/logo.png" alt="LIEN" width="120" />
</p>

<h1 align="center">LIEN</h1>

<p align="center">
  <strong>The credit bureau for autonomous AI agents.</strong><br/>
  Creditworthiness scores derived from on-chain identity and real payment behavior,
  served over a REST API and a TypeScript SDK.
</p>

<p align="center">
  <a href="https://lien-api-production.up.railway.app/v1/registry?limit=1">Live API</a> ·
  <a href="LIEN-docs.md">API Reference</a> ·
  <a href="https://lien.credit">lien.credit</a>
</p>

---

## Table of contents

- [What is LIEN](#what-is-lien)
- [Why it matters](#why-it-matters)
- [How it works](#how-it-works)
- [The post-paid loop](#the-post-paid-loop)
- [Quickstart](#quickstart)
- [Identity model](#identity-model)
- [Scoring model](#scoring-model)
- [API surface](#api-surface)
- [TypeScript SDK](#typescript-sdk)
- [Webhooks](#webhooks)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Status and roadmap](#status-and-roadmap)
- [License](#license)

## What is LIEN

Autonomous agents increasingly pay for services — APIs, compute, data, other agents.
Today nearly every one of those interactions is **prepaid**, because there is no neutral
way to know whether an agent is good for the money. LIEN closes that gap: it scores an
agent's creditworthiness so providers can safely extend **post-paid** terms — run a tab,
settle later — the same leap consumer credit made decades ago, now for machines.

A LIEN score (300–850, like a FICO) answers one question: *can this agent be trusted with
a line of credit, and how large should it be?* The score is deterministic, transparent,
and reproducible — the same inputs always yield the same number, broken down into the
factors that produced it.

## Why it matters

| Without credit | With LIEN |
|---|---|
| Every call is prepaid; capital sits locked in escrow. | Providers extend a metered tab and settle net once per period. |
| New providers can't price risk, so they refuse or over-charge. | Risk is priced from a portable, neutral score. |
| Good actors and bad actors are treated identically. | Track record compounds into a higher limit over time. |
| Reputation is siloed per platform. | One credit file follows the agent across providers. |

## How it works

LIEN scores **behavior**; it does not issue identity. An agent is recognized through one
or more identity sources, and its credit file is the union of what they report:

| Source | Provides | Example `agent_id` |
|---|---|---|
| **8004 registry** (Solana Agent Registry) | Identity, reputation, account age | `FAQXa8Sv7f…` (8004 account) |
| **Payment wallet / x402** | Settlement behavior — volume, on-time rate, diversity, defaults | the paying wallet address |

- An **8004 agent** is scored from its on-chain reputation, blended with any settlements
  reported to LIEN. Agents with no settlement history yet are *bootstrapped* from
  reputation signals alone.
- A **wallet-only (x402) agent** is scored purely from its reported settlement ledger —
  no on-chain registration required. This extends coverage far beyond the agents that have
  self-registered on 8004.
- When the same operator controls both an 8004 account and a payment wallet, the two can be
  **cryptographically linked** into a single canonical credit file (see [Identity model](#identity-model)).

> LIEN never mints identities on an agent's behalf. A registry entry is only meaningful
> when its owner holds the key. LIEN observes the identities that already exist and scores
> the behavior attached to them.

## The post-paid loop

```
check score  →  open tab  →  meter usage  →  settle net  →  report outcome  →  re-score
```

```ts
import { Lien } from "@lien/sdk";

const lien = new Lien({ apiKey: process.env.LIEN_API_KEY!, network: "mainnet" });

const credit = await lien.check(agentId);
if (!credit.limit) return requirePrepay(agentId);          // not creditworthy → prepay

const tab = billing.openTab(agentId, credit.limit);         // extend post-paid terms
// ... usage accrues over the period ...
const result = await billing.settle(tab);                   // one net settlement

await lien.settlements.create(                              // outcome feeds the next score
  { agent_id: agentId, tab_id: tab.id, amount: result.amount, on_time: result.onTime },
  { idempotencyKey: result.id },
);
```

## Quickstart

Reads are public — no key needed. Score any agent right now:

```bash
# A real mainnet 8004 agent
curl https://lien-api-production.up.railway.app/v1/report/FAQXa8Sv7foH53gV78u1Rbs1fwaCKrg8oxesCEyeNbEh

# Top of the registry, by score
curl "https://lien-api-production.up.railway.app/v1/registry?sort=score&limit=10"
```

Install the SDK:

```bash
npm install @lien/sdk
```

See the full **[API Reference](LIEN-docs.md)** for every endpoint, object, error, webhook,
and the scoring model in detail.

## Identity model

LIEN maintains a single canonical credit file per agent. The `agent_id` you query is
resolved to that canonical file before scoring:

1. **8004 account id** — the agent's Solana Agent Registry account. Carries reputation and
   account age in addition to any reported settlements.
2. **Payment wallet** — used directly when an agent transacts via x402 without an 8004
   entry. Scored from the settlement ledger alone.
3. **Linked wallet → 8004** — once linked, a wallet query transparently resolves to the
   8004 file, and that file's score unions settlements from the 8004 account and every
   linked wallet.

Linking is **explicit and signed**. `POST /v1/agents/:agent_id/link` requires Ed25519
signatures from **both** the wallet owner and the 8004 owner over a canonical message.
Neither party can be merged into the other's file without proving control of its key, which
prevents impersonation and reputation theft.

## Scoring model

Deterministic and transparent. Computed off-chain over a trailing 90-day window and
returned with a full per-factor breakdown:

| Factor | Measures | Weight |
|---|---|---|
| `on_time_rate` | Share of obligations closed on time | 0.30 |
| `volume` | Total settled value in the window | 0.25 |
| `account_age` | Days the identity has been active | 0.15 |
| `counterparty_diversity` | Number of distinct counterparties | 0.15 |
| `defaults` | Unsettled obligations (penalty) | 0.15 |

- For wallet-only agents, `account_age` is derived from the first settlement LIEN observed.
- New 8004 agents with no ledger are **bootstrapped** from reputation signals, with the
  `bootstrapped` flag set on the affected factors.
- The 300–850 result buckets into bands and a recommended credit `limit` that scales with
  both score and the agent's typical per-period volume.

| Band | Score range |
|---|---|
| `poor` | 300–579 |
| `fair` | 580–669 |
| `good` | 670–739 |
| `very_good` | 740–799 |
| `excellent` | 800–850 |

Each agent also carries a `status`: `good_standing`, `on_watch`, or `defaulted`.

## API surface

Base URL: `https://lien-api-production.up.railway.app/v1`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/score/:agent_id` | public | Score, band, status, and recommended limit. |
| `GET` | `/v1/report/:agent_id` | public | Full report: score, factor breakdown, identity, recent settlements. |
| `GET` | `/v1/registry` | public | Paginated list of scored agents. Supports `sort` (`score`/`volume`/`recent`), `status`, `limit`, `starting_after`. Items include `name`, `image`, `synthetic`. |
| `POST` | `/v1/settlements` | key | Report a settlement outcome (idempotent via `Idempotency-Key`). Feeds the next score. |
| `POST` | `/v1/attest/:agent_id` | key | Validate `feedback_auth` and (when a signer is configured) write the score back on-chain. |
| `POST` | `/v1/agents/:agent_id/link` | key | Link a payment wallet to an 8004 agent. Requires signatures from both owners. |

- **Reads are public.** Write endpoints require `Authorization: Bearer <LIEN_API_KEY>`
  when a key is configured on the server.
- **Rate limit:** 120 requests per minute per IP (configurable). Responses carry
  `x-ratelimit-*` headers.
- Agent ids that contain colons (e.g. `agent:sol:…`) are passed as a path segment as-is.

## TypeScript SDK

`@lien/sdk` is a thin, typed client over the REST API.

| Method | Calls | Purpose |
|---|---|---|
| `lien.check(agentId)` | `GET /score/:id` | Quick score + limit. |
| `lien.report(agentId)` | `GET /report/:id` | Full report with factors and settlements. |
| `lien.registry(params)` | `GET /registry` | Paginated registry listing. |
| `lien.settlements.create(body, opts)` | `POST /settlements` | Report an outcome (idempotent). |
| `lien.x402.authorize(payer)` | `GET /score/:wallet` | Decide post-paid vs prepay for an x402 payer. |
| `lien.x402.reportPayment(payment)` | `POST /settlements` | Record an x402 payment as a settlement. |
| `lien.link(agentId, proof)` | `POST /agents/:id/link` | Link a wallet to an 8004 file. |

The post-paid loop and an x402 resource-server example live in
[`sdk/examples/`](sdk/examples).

## Webhooks

LIEN delivers HMAC-SHA-256 signed events (header `X-Lien-Signature`) with retry on failure:

| Event | Fires when |
|---|---|
| `score.updated` | An agent's score or band changes. |
| `agent.defaulted` | An agent enters `defaulted` status. |
| `agent.recovered` | An agent returns to `good_standing`. |
| `attestation.written` | A score is attested on-chain. |
| `tab.settlement_due` | *(planned)* a tab's settlement window closes. |

Configure with `LIEN_WEBHOOK_URL` + `LIEN_WEBHOOK_SECRET`, or multiple endpoints via
`LIEN_WEBHOOKS` (JSON array).

## Architecture

```
            8004 indexer (GraphQL)         x402 / provider settlements
                     │                                │
                     ▼                                ▼
            ┌───────────────────────────────────────────────┐
            │                Scoring service                 │
            │   reader · derive · engine · linking · webhooks │
            └───────────────────────────────────────────────┘
                     │                  │                 │
                     ▼                  ▼                 ▼
               Store (Postgres)   REST API (Fastify)   Attestation
                                       │                (program)
                                       ▼
                          SDK · frontend · providers
```

- **Reader** pulls agent identity, reputation, and account age from the 8004 indexer.
- **Engine** computes the deterministic score from ledger + reputation signals.
- **Store** persists agents, scores, settlements, idempotency keys, and wallet→8004 aliases.
  Postgres in production (durable, so the ledger accumulates across restarts), with
  Supabase and in-memory backends available.
- **Attestation** can write the score back on-chain through an Anchor program (a no-op
  writer is used until a signer and program id are configured).

## Repository layout

| Path | What |
|---|---|
| [`api/`](api) | Backend — 8004 GraphQL reader, scoring engine, Fastify REST API, storage backends, webhooks, attestation, linking. |
| [`sdk/`](sdk) | `@lien/sdk` — TypeScript client, the post-paid demo, and an x402 server example. |
| [`program/`](program) | Anchor program for writing scores on-chain (Solana). |
| [`db/`](db) | PostgreSQL schema for the public profile/registry frontend. |
| [`LIEN-docs.md`](LIEN-docs.md) | Full API reference. |

## Local development

```bash
# API
cd api
npm install
npm run dev          # http://127.0.0.1:8787
npm test             # unit tests (scoring, linking, services)
npm run typecheck

# SDK + post-paid demo (with the API running)
cd ../sdk
npm install
npm run demo
```

With no database configured the API is fully self-contained: on boot it seeds synthetic
demo agents and scores the top real mainnet 8004 agents into an in-memory store, so it runs
with zero external dependencies. Synthetic records are flagged `synthetic: true` and must
never be presented as real live metrics.

## Configuration

Key environment variables (see [`api/.env.example`](api/.env.example) for the full list):

| Variable | Purpose |
|---|---|
| `LIEN_CLUSTER` | `mainnet` or `devnet` — which 8004 indexer to read. |
| `PORT` / `HOST` | HTTP bind. |
| `DATABASE_URL` | Postgres connection string (enables durable storage). |
| `LIEN_API_KEY` | When set, gates write endpoints behind a bearer token. |
| `LIEN_RATE_LIMIT` | Max requests per IP per minute (default 120). |
| `LIEN_SEED` | Seed synthetic demo agents on boot. |
| `LIEN_SEED_REAL` | Score the top-N real 8004 agents into the store on boot. |
| `LIEN_WEBHOOK_URL` / `LIEN_WEBHOOK_SECRET` | Webhook delivery + signing. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Optional Supabase storage backend. |
| `LIEN_SIGNER_SECRET` / `LIEN_SCORE_PROGRAM_ID` | Enable on-chain attestation writes. |

## Deployment

The API ships as a multi-stage Docker image and is deployed on Railway against a managed
Postgres instance. Configuration lives in [`api/Dockerfile`](api/Dockerfile) and
[`api/railway.json`](api/railway.json); a Render blueprint is also provided
([`render.yaml`](render.yaml)).

```bash
cd api
docker build -t lien-api .
docker run -p 8787:8787 --env-file .env lien-api
```

## Status and roadmap

- Live: 8004 reader, scoring engine, REST API, SDK, webhooks.
- Live: mainnet API on Railway with durable Postgres storage and public reads.
- Live: x402 / wallet-only (ledger) scoring path.
- Live: signed wallet ↔ 8004 linking.
- In progress: on-chain attestation write (authority signer + Anchor program deploy).
- Planned: anti-gaming defenses, sponsored self-registration, `tab.settlement_due` webhook.

## License

Proprietary — all rights reserved (pre-release).
