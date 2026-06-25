import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

/**
 * Wallet ↔ 8004 identity linking.
 *
 * A payment wallet and an 8004 account are distinct addresses, so the same agent
 * can hold two credit files. Linking merges them — but only with consent from BOTH
 * sides, signed, to prevent two abuses:
 *   - impersonation: an attacker linking their wallet to a famous agent to inherit
 *     its score (blocked by requiring the 8004 owner's signature);
 *   - history theft: an agent absorbing a wallet it doesn't control (blocked by
 *     requiring the wallet's own signature).
 *
 * Both parties sign the same canonical message. Signatures are ed25519 (Solana),
 * base58-encoded, verified against the signer's public key (also base58).
 */

/** The canonical message both parties sign to authorize a link. */
export function linkMessage(agentId: string, wallet: string): string {
  return `lien:link:v1:${agentId}:${wallet}`;
}

/** Verify a base58 ed25519 signature of `message` by the given base58 public key. */
export function verifyEd25519(publicKeyB58: string, message: string, signatureB58: string): boolean {
  try {
    const pub = bs58.decode(publicKeyB58);
    const sig = bs58.decode(signatureB58);
    if (pub.length !== 32 || sig.length !== 64) return false;
    const msg = new TextEncoder().encode(message);
    return ed25519.verify(sig, msg, pub);
  } catch {
    return false;
  }
}

export type LinkValidation = { ok: true } | { ok: false; reason: string; param?: string };

/**
 * Validate a link request: both the wallet and the 8004 owner must have signed the
 * canonical link message. `owner` is the 8004 agent's on-chain owner pubkey.
 */
export function validateLink(params: {
  agentId: string;
  wallet: string;
  owner: string;
  walletSignature: unknown;
  ownerSignature: unknown;
}): LinkValidation {
  const { agentId, wallet, owner, walletSignature, ownerSignature } = params;

  if (typeof wallet !== "string" || wallet.length === 0) {
    return { ok: false, reason: "wallet is required", param: "wallet" };
  }
  if (typeof walletSignature !== "string" || walletSignature.length === 0) {
    return { ok: false, reason: "wallet_signature is required", param: "wallet_signature" };
  }
  if (typeof ownerSignature !== "string" || ownerSignature.length === 0) {
    return { ok: false, reason: "owner_signature is required", param: "owner_signature" };
  }

  const message = linkMessage(agentId, wallet);
  if (!verifyEd25519(wallet, message, walletSignature)) {
    return { ok: false, reason: "wallet_signature is invalid", param: "wallet_signature" };
  }
  if (!verifyEd25519(owner, message, ownerSignature)) {
    return { ok: false, reason: "owner_signature is invalid", param: "owner_signature" };
  }

  return { ok: true };
}
