import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { linkMessage, validateLink, verifyEd25519 } from "./linking.js";

function keypair() {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv, pubB58: bs58.encode(pub) };
}

function sign(priv: Uint8Array, message: string): string {
  return bs58.encode(ed25519.sign(new TextEncoder().encode(message), priv));
}

const AGENT = "FAQXa8Sv7foH53gV78u1Rbs1fwaCKrg8oxesCEyeNbEh";

test("verifyEd25519 accepts a valid signature and rejects tampering", () => {
  const { priv, pubB58 } = keypair();
  const msg = linkMessage(AGENT, pubB58);
  assert.equal(verifyEd25519(pubB58, msg, sign(priv, msg)), true);
  assert.equal(verifyEd25519(pubB58, msg + "x", sign(priv, msg)), false); // different message
  assert.equal(verifyEd25519(pubB58, msg, bs58.encode(new Uint8Array(64))), false); // zero sig
});

test("validateLink requires both wallet and owner signatures over the canonical message", () => {
  const wallet = keypair();
  const owner = keypair();
  const msg = linkMessage(AGENT, wallet.pubB58);

  const ok = validateLink({
    agentId: AGENT,
    wallet: wallet.pubB58,
    owner: owner.pubB58,
    walletSignature: sign(wallet.priv, msg),
    ownerSignature: sign(owner.priv, msg),
  });
  assert.equal(ok.ok, true);
});

test("validateLink rejects when a signer signs the wrong message (impersonation/theft)", () => {
  const wallet = keypair();
  const owner = keypair();
  const attacker = keypair();
  const msg = linkMessage(AGENT, wallet.pubB58);

  // Owner signature produced by someone who isn't the owner → rejected.
  const forgedOwner = validateLink({
    agentId: AGENT,
    wallet: wallet.pubB58,
    owner: owner.pubB58,
    walletSignature: sign(wallet.priv, msg),
    ownerSignature: sign(attacker.priv, msg),
  });
  assert.equal(forgedOwner.ok, false);

  // Wallet didn't actually sign (someone else did) → rejected.
  const forgedWallet = validateLink({
    agentId: AGENT,
    wallet: wallet.pubB58,
    owner: owner.pubB58,
    walletSignature: sign(attacker.priv, msg),
    ownerSignature: sign(owner.priv, msg),
  });
  assert.equal(forgedWallet.ok, false);
});

test("validateLink reports missing fields", () => {
  const r = validateLink({
    agentId: AGENT,
    wallet: "",
    owner: "x",
    walletSignature: "",
    ownerSignature: "",
  });
  assert.equal(r.ok, false);
});
