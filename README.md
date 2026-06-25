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
  <a href="https://lien-api-production.up.railway.app/health">Live API</a> ·
  <a href="LIEN-docs.md">API Reference</a> ·
  <a href="https://lien.credit">lien.credit</a>
</p>

---

## What is LIEN?

Autonomous agents increasingly pay for services — APIs, compute, data, other agents.
Today every one of those interactions is **prepaid**, because there's no way to know
whether an agent is good for the money. LIEN fixes that: it scores an agent's
creditworthiness so providers can safely extend **post-paid** terms (run a tab, settle
later) — the same leap consumer credit made decades ago, now for machines.

A LIEN score (300–850, like a FICO) answers one question: *can this agent be trusted
with a line of credit, and how big?*

## How it works

LIEN scores behavior, it doesn't issue identity. An agent is recognized through one or
more **identity sources**, and its credit file is the union of what they tell us:

| Source | Provides | Example `agent_id` |
|---|---|---|
| **8004 registry** (Solana Agent Registry) | Identity + reputation + account age | `FAQXa8Sv7f...` (8004 account) |
| **Payment wallet / x402** | Real settlement behavior — volume, on-time rate, diversity, defaults | the paying wallet address |

- An **8004 agent** is scored from its reputation, blended with any settlements
  reported to LIEN. New agents are *bootstrapped* from reputation alone.
- A **wallet-only (x402) agent** is scored purely from its reported settlement ledger —
  no on-chain registration required. This lets LIEN cover agents far beyond the ~1.5k
  self-registered on 8004.

> LIEN never mints identities on an agent's behalf — a registry entry is only
> meaningful when its owner holds the key. LIEN observes the identities that already
> exist and scores the behavior attached to them.

## The post-paid loop

```
check score  →  open tab  →  meter usage  →  settle net  →  report outcome  →  re-score
```

```ts
import { Lien } from "@lien/sdk";

const lien = new Lien({ apiKey: process.env.LIEN_API_KEY!, network: "mainnet" });

const credit = await lien.check(agentId);
if (!credit.limit) return requirePrepay(agentId);        // not creditworthy → prepay

const tab = billing.openTab(agentId, credit.limit);       // extend post-paid terms
// ... usage accrues over the period ...
const result = await billing.settle(tab);                 // one net settlement

await lien.settlements.create(                             // outcome feeds the next score
  { agent_id: agentId, tab_id: tab.id, amount: result.amount, on_time: result.onTime },
  { idempotencyKey: result.id },
);
```

## Quickstart

Reads are public — no key needed. Score any agent right now:

```bash
# A real mainnet 8004 agent
curl https://lien-api-production.up.railway.app/v1/report/FAQXa8Sv7foH53gV78u1Rbs1fwaCKrg8oxesCEyeNbEh

# Top of the registry
curl "https://lien-api-production.up.railway.app/v1/registry?sort=score&limit=10"
```

See the full **[API Reference](LIEN-docs.md)** for every endpoint, object, webhook, and
the scoring model.

## Scoring model

Deterministic and transparent — same inputs, same score. Computed off-chain over a
trailing 90-day window:

| Factor | Measures | Weight |
|---|---|---|
| `on_time_rate` | Share of obligations closed on time | 0.30 |
| `volume` | Total settled value in the window | 0.25 |
| `account_age` | Days the identity has been active | 0.15 |
| `counterparty_diversity` | Distinct counterparties | 0.15 |
| `defaults` | Count of unsettled obligations (penalty) | 0.15 |

The 300–850 result buckets into bands (`poor` · `fair` · `good` · `very_good` ·
`excellent`) and a recommended credit `limit` that scales with both score and the
agent's typical per-period volume.

## Repository layout

| Path | What |
|---|---|
| [`api/`](api) | Backend — 8004 GraphQL reader, scoring engine, Fastify REST API, webhooks, attestation. |
| [`sdk/`](sdk) | `@lien/sdk` — TypeScript client + the post-paid demo (`sdk/examples/postpaid.ts`). |
| [`program/`](program) | Anchor program for writing scores on-chain (Solana). |
| [`db/`](db) | PostgreSQL schema for the public profile/registry frontend. |
| [`LIEN-docs.md`](LIEN-docs.md) | Full API reference. |
| [`LIEN_CONTEXT.md`](LIEN_CONTEXT.md) | Project spec and design notes. |

## Development

```bash
# API
cd api
npm install
npm run dev          # http://127.0.0.1:8787
npm test

# SDK + post-paid demo (with the API running)
cd ../sdk
npm install
npm run demo
```

The API is self-contained: on boot it seeds synthetic demo agents plus real mainnet
8004 agents into an in-memory store, so it runs with zero external dependencies.

## Status

- ✅ 8004 reader, scoring engine, REST API, SDK, webhooks — live
- ✅ Live mainnet API on Railway, public reads
- ✅ x402 / wallet-only (ledger) scoring path
- 🚧 On-chain attestation write (signer + program deploy pending)
- 🗺️ Signed wallet↔8004 linking · sponsored self-registration

## License

Proprietary — all rights reserved (pre-release).
