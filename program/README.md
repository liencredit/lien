# LIEN `/program`

Anchor (Rust) program that stores each agent's LIEN score in an on-chain PDA, so
any 8004-aware service can read it without trusting our API. Optional for the v0
demo; on the roadmap for the full stack.

## What it does

- A global `Config` PDA (`seeds = ["config"]`) holds the **authority** allowed to
  write scores — the LIEN scoring service signer.
- A per-agent `ScoreAccount` PDA (`seeds = ["lien-score", agent_pubkey]`) holds
  `{ score (300–850), band, status, updated_at }`.
- `set_score` is gated to the config authority and emits a `ScoreUpdated` event.

## Instructions

| Instruction | Who | Effect |
|---|---|---|
| `initialize(authority)` | anyone (once) | create the config |
| `set_authority(new)` | current authority | rotate the writer |
| `set_score(agent, score, band, status)` | authority | upsert an agent's score PDA |

Enums on-chain: band `0=poor…4=excellent`; status `0=good_standing,1=on_watch,2=defaulted`.

## Prerequisites (not installed in this workspace)

This program is written but **not built/deployed here** — it needs the Solana
toolchain:

```bash
# Rust + Solana CLI + Anchor
curl https://sh.rustup.rs -sSf | sh
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --force && avm install 0.30.1 && avm use 0.30.1
```

## Build, test, deploy

```bash
npm install
anchor build
anchor keys sync         # writes the real program id into lib.rs + Anchor.toml
anchor test              # boots a local validator and runs tests/
anchor deploy --provider.cluster devnet
```

After deploy, set `LIEN_SCORE_PROGRAM_ID` in `../api/.env` so the attestation
writer can target the PDA (see `../api/src/service/attestation.ts`).
