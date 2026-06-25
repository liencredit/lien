# LIEN — Project Context

> Drop this in the repo root. For Claude Code, rename to `CLAUDE.md` so it auto-loads.
> For Cursor, keep as is and `@LIEN_CONTEXT.md` it, or paste into `.cursorrules`.
> This file is the source of truth for what LIEN is and what still needs building.
> The full API spec lives in `LIEN-docs.md` — treat it as authoritative for object
> shapes and endpoints.

---

## 1. What LIEN is

LIEN is a **credit bureau for autonomous AI agents**. It reads an agent's on-chain
payment/reputation history, computes a creditworthiness score (300–850), and lets
service providers extend **post-paid** terms (a running tab settled net at period
end) instead of demanding prepay before every call.

- One-liner: **Credit scores for AI agents. Open a tab.**
- The model: read the on-chain record → score it → unlock post-paid for good standing.
- Positioning: LIEN does **not** build its own identity layer. It sits **on top of
  ERC-8004** (on Solana, Quantu's Agent Registry). It is the "specialized reputation
  aggregator / scoring protocol" that the 8004 spec explicitly anticipates being
  built on top of it. Every LIEN score is bound to an 8004 agent identity.
- Token: there is a `$LIEN` token for the launch, but it is **out of scope for the
  product and the docs**. Do not add token logic, token sections, or token copy to
  the app or the API. If you see it referenced, ignore it here.

---

## 2. Brand (keep all UI on-brand)

- Name: **LIEN**. Tagline: **Credit scores for AI agents. Open a tab.**
- Aesthetic: **antique financial institution** — engraved banknote / vintage credit
  certificate / letterpress / old ledger. Authoritative, austere, flat. NOT a
  generic SaaS dashboard. No purple, no gradients, no glassmorphism, no neon, no
  drop shadows.
- Palette: bone `#F2ECDF` (bg), oxblood `#7A2230` (primary/borders/seals), ink
  `#211C17` (text), antique brass `#A8842C` (accents only), approved green `#2E6B4A`,
  watch amber `#B5791F`, default red `#9B2D2D`.
- Type: headings + LIEN wordmark in **Playfair Display** (high-contrast serif); all
  data / numbers / IDs / addresses in **JetBrains Mono**; body in **Inter**.
- Status stamps `GOOD STANDING / ON WATCH / DEFAULTED` render uppercase, letter-
  spaced, like an inked rubber stamp. Everything else sentence case.
- Logo: a seal with a geometric `L` crossed by a single horizontal bar (the "lien"
  claim). Final mark pending; leave a logo slot in the header.

---

## 3. Repo layout — where front and back live

```
/lien
  /web        FRONTEND — exists. React app generated in Lovable. Currently renders
              MOCK data behind a single service file. Needs to be pointed at the real
              API. (May currently be a standalone Lovable export — if so, treat it as
              its own project and just set its API base URL to the /api service.)

  /api        BACKEND — to build. Node + TypeScript service. Holds:
                - the 8004 reader (GraphQL + 8004-solana SDK)
                - the scoring engine
                - the REST API (see LIEN-docs.md)
                - the write-back / attestation path
              Talks to Supabase for storage and to Quantu's 8004 GraphQL for data.

  /program    ON-CHAIN — to build. Anchor (Rust) program holding a per-agent PDA
              with the LIEN score. Small. Optional for v0 demo but on the roadmap.

  /sdk        SDK — to build. Thin TypeScript wrapper over the REST API
              (`lien.check`, `lien.report`, etc. — see LIEN-docs.md).
```

**Frontend = `/web` (done, mock data). Backend = `/api` (build this first).**

---

## 4. Stack

- Frontend: React (Lovable export), Tailwind. Fonts via Google Fonts.
- Backend: Node 20 + TypeScript. Fastify or Express. Zod for validation.
- Storage: Supabase (Postgres). Tables: `agents`, `scores`, `settlements`.
- Solana / 8004: `8004-solana` SDK + Quantu's hosted GraphQL. Optional: Helius RPC
  for raw x402 settlement enrichment.
- On-chain: Anchor (Rust) for the LIEN score PDA.
- Start on **devnet**. Ship v0 on devnet, move to mainnet after the demo.

---

## 5. Architecture / data flow

```
8004 GraphQL (Quantu)  ──read──▶  /api 8004-reader  ──▶  scoring engine
        ▲                                                      │
        │ write-back (feedback w/ score, pre-auth)             ▼
        └──────────────────────────────  Supabase (scores) ──▶ REST API ──▶ /web
                                                 │
                                          /program PDA (on-chain score, optional)
```

1. Reader pulls an agent's identity + feedback (incl. x402 payment tags) from 8004.
2. Scoring engine computes score / band / status / limit.
3. Store in Supabase; optionally write the score to the on-chain PDA.
4. REST API serves scores/reports/registry to the frontend.
5. Write-back: post the score as 8004 feedback (opt-in via the agent's pre-auth) so
   it travels with the agent's passport.

---

## 6. 8004 integration — GROUNDED, do not improvise

Quantu's 8004 stack is live and open-source. **Verify current details against the
authoritative skill reference before coding:** `skill.md` lives in the SDK repo at
`https://github.com/QuantuLabs/8004-solana-ts/blob/main/skill.md` (the old
`https://8004.qnt.sh/skill.md` path 404s / times out). It is the authoritative
SDK/endpoint reference.

- **SDK:** `npm i 8004-solana` (TypeScript; identity, reputation, feedback, signing).
- **GraphQL API (verified live 2026-06):** the indexer moved off the bare apex domain.
  Use the per-cluster indexer subdomains for all reads:
  - Devnet (reference): `https://8004-indexer-dev.qnt.sh/v2/graphql`
  - Mainnet (production): `https://8004-indexer-main.qnt.sh/v2/graphql`
  - Health/ready: `…/health`, `…/ready`. Secondaries exist (`…-dev2`, `…-main2`).
  - **NOTE:** the old `https://8004.qnt.sh/v2/graphql` returns 404 — do not use it.
- **Self-host indexer (optional):** `github.com/QuantuLabs/8004-solana-indexer`.
- **MCP server:** `@quantulabs/8004-mcp`. **Studio:** `studio.qnt.sh`. **Spec:** `8004.org`.

**Key facts that shape the design:**

- Agents are **Metaplex Core NFTs** + metadata PDAs (identity).
- Reputation/feedback is **events-only** (SEAL v1 hash-chains). **Do not read raw
  event streams** — read through the verified indexer / GraphQL only.
- Feedback already carries **tags for uptime, quality, and x402 payments** — so a
  meaningful chunk of the payment signal is already in 8004. Use it; only reach for
  Helius if you need richer raw x402 data than the tags provide.
- Writing feedback uses **pre-authorization**: the agent signs an authorization
  permitting a client (us) to post. LIEN is the anticipated "reputation aggregator."
- **ATOM engine** is an optional on-chain reputation layer (5-tier trust,
  quality/risk). Treat the ATOM tier as one scoring input if present.
- Program IDs (reference — confirm against `skill.md`):
  - Mainnet agent registry: `8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ`
  - Devnet agent registry: `8oo4J9tBB3Hna1jRQ3rWvJjojqM5DYTDJo5cejUuJy3C`

**Resolve an agent (identity + wallet + endpoints + ATOM signals).** Verified:
`agent.solana` carries the ATOM `qualityScore` (0–10000) and `trustTier` (0–4 =
Unrated→Bronze→Silver→Gold→Platinum); `createdAt` is a unix-seconds `BigInt` string
(use it for `account_age`):

```graphql
query($id: ID!) {
  agent(id: $id) {
    id agentId owner totalFeedback createdAt updatedAt
    solana { assetPubkey qualityScore trustTier }
    registrationFile { name description image active mcpEndpoint a2aEndpoint }
  }
}
```

**Read an agent's feedback.** Verified `Feedback` fields: `value` is the rating
(`BigDecimal`), `tag1`/`tag2` carry the signal labels (e.g. `uptime`, `quality`,
`x402`), `endpoint` is the rated endpoint, `createdAt`/`revokedAt` are unix-seconds.
**There is no payment-amount field on feedback** — the on-chain record gives
reputation + tags + recency + counterparties, NOT settlement value (see §8):

```graphql
query($a: ID!) {
  feedbacks(first: 50, where: { agent: $a }, orderBy: createdAt, orderDirection: desc) {
    id clientAddress value tag1 tag2 endpoint isRevoked createdAt revokedAt
  }
}
```

**Enumerate recently-updated agents (for the registry / batch scoring):**

```graphql
query($from: BigInt!, $to: BigInt!) {
  agents(first: 100, where: { updatedAt_gt: $from, updatedAt_lt: $to },
         orderBy: updatedAt, orderDirection: asc) {
    id owner totalFeedback updatedAt
  }
}
```

---

## 7. Data model

Full typed shapes are in `LIEN-docs.md` (objects: `credit_score`, `limit`, `factor`,
`report`, `settlement`). Mirror those exactly in the API responses. Key enums:

- `status`: `good_standing | on_watch | defaulted`
- `band`: `poor | fair | good | very_good | excellent`
- `settlement.status`: `settled | late | defaulted`

Supabase tables (minimum):
- `agents` — agent_id (pk), owner, payment_wallet, name, image, first_seen.
- `scores` — agent_id (pk), score, band, status, limit_amount, limit_period,
  attested, factors (jsonb), updated_at.
- `settlements` — id (pk), agent_id, tab_id, amount, currency, status, on_time, occurred_at.

---

## 8. Scoring model (v0 — keep it transparent/linear)

Trailing 90-day window. Deterministic: same inputs → same score.

**Two input sources (verified against the live indexer).** 8004 feedback is
rating + tags + timestamp + counterparties — it has **no settlement amount**. So the
score blends (a) imported 8004 reputation with (b) LIEN's own settlement ledger:

| Factor (`key`)            | Measures                                  | Weight | Source |
|---------------------------|-------------------------------------------|--------|--------|
| `on_time_rate`            | Share of obligations closed on time       | 0.30   | LIEN ledger (`/settlements`) |
| `volume`                  | Total settled value in the window         | 0.25   | LIEN ledger (`/settlements`) |
| `account_age`             | Days the 8004 identity has been active    | 0.15   | 8004 (`agent.createdAt`) |
| `counterparty_diversity`  | Distinct counterparties                   | 0.15   | 8004 (distinct `clientAddress`) + ledger |
| `defaults`                | Count of unsettled obligations (penalty)  | 0.15   | LIEN ledger (`/settlements`) |

**Bootstrap for agents with no LIEN ledger yet:** seed `on_time_rate`/`volume` from
8004 reputation proxies — feedback `value` distribution, the share of non-revoked
feedback, ATOM `qualityScore` (0–10000) and `trustTier` (0–4) — so a real devnet
agent we've never settled with still gets a meaningful (if conservative) score
instead of an empty one. As real settlements arrive, ledger signal overrides the
bootstrap.

- Normalize each factor to 0–1, apply weights, map the weighted sum to **300–850**.
- Bands: `poor` <580, `fair` 580–669, `good` 670–739, `very_good` 740–799,
  `excellent` 800+.
- `status`: `good_standing` if no active default and score ≥ ~670; `on_watch` if
  score in a middling band or a recent late settle; `defaulted` if any unsettled
  obligation.
- `limit`: scales with score AND the agent's typical per-period settlement volume,
  so a high score on a low-volume agent still yields a conservative ceiling. `null`
  when not eligible.

---

## 9. API surface (build to `LIEN-docs.md`)

- `GET  /v1/score/:agent_id` → `credit_score`
- `GET  /v1/report/:agent_id` → `report`
- `GET  /v1/registry?sort=&status=&limit=&starting_after=` → paginated list
- `POST /v1/settlements` (idempotent via `Idempotency-Key`) → `settlement`
- `POST /v1/attest/:agent_id` (requires agent feedback auth) → `credit_score`

Bearer auth, cursor pagination, the error object + webhook events — all specified in
`LIEN-docs.md`. Implement webhooks (`score.updated`, `agent.defaulted`,
`tab.settlement_due`, etc.) after the core endpoints.

---

## 10. Build order (do these in sequence)

0. **Read spike.** Call the GraphQL above against `8004.qnt.sh/v2/graphql`, pull a
   real devnet agent + its feedback. Confirm we can read what we need to score.
1. **`/api` 8004 reader.** `resolveAgent(id)`, `getFeedback(id)`, optional ATOM read.
   Wrap GraphQL + `8004-solana`.
2. **Scoring engine.** Pure function: inputs → `{ score, band, status, limit, factors }`.
   Unit-test it with fixtures.
3. **Storage.** Supabase tables + upsert from reader → scorer → `scores`.
4. **REST API.** Endpoints in §9, served from Supabase, brand-agnostic JSON.
5. **Wire `/web`.** Replace the frontend's mock service with calls to the API base URL.
6. **`/program` PDA.** Anchor program storing per-agent score; `set_score` gated to
   our authority. Devnet deploy.
7. **Write-back / attest.** Post 8004 feedback with the score via the SDK (pre-auth).
8. **Post-paid demo.** Small provider script: check score → open tab → meter → settle
   → `POST /settlements`. This is the launch clip.

---

## 11. Constraints & conventions

- Solo dev, fast iteration. TypeScript everywhere except the Anchor program. Keep
  dependencies light.
- v0 over perfection: simple linear scoring, devnet first, ship the loop.
- **Honest data:** real x402 volume on Solana is still thin. For the demo, seed
  Supabase with a handful of synthetic agents behind an explicit `seed` script/flag
  so the registry and profiles look alive — but never present synthetic numbers as
  real live metrics in production copy.
- Reads go through 8004's verified indexer/GraphQL, never raw event streams.
- Keep all generated UI strictly on the brand in §2.
- No `$LIEN` token logic or copy anywhere in the product or docs.

---

## 12. Status

- Done:
  - `LIEN-docs.md` (API reference), landing/`web` (Lovable, mock data).
  - Read spike against the live 8004 indexer (devnet) — verified shapes/endpoints.
  - `/api`: 8004 reader, scoring engine (pure + unit-tested), in-memory storage
    behind a `Store` interface, `db/schema.sql` for Supabase, deterministic
    synthetic `seed`, and the REST API (`/score`, `/report`, `/registry`,
    `/settlements` w/ idempotency, `/attest` w/ feedback-auth validation).
  - `/sdk`: typed client (`check`/`report`/`registry`/`settlements.create`/`attest`)
    + webhook verification, and the post-paid demo (`examples/postpaid.ts`).
  - `/program`: Anchor score PDA written (Config + per-agent ScoreAccount,
    `set_score` gated to authority) — code complete, not yet built/deployed.
- Not done / partial:
  - Wire `/web` to the real API (deferred to last).
  - `/program` build + devnet deploy (needs the Solana/Anchor toolchain installed).
  - Real `AttestationWriter` (on-chain PDA / 8004 feedback write) — currently noop;
    validation + plumbing are in place behind `LIEN_SIGNER_SECRET` + `LIEN_SCORE_PROGRAM_ID`.
  - Supabase-backed `Store` (adapter slots into `createStore`); schema is ready.
  - Webhook dispatch on the API side (SDK-side verification exists).
- Open: final logo selection; domain + X handle (TBD — set once, then update the API
  base URL and any in-app links consistently).
```
