import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

// Run with `anchor test` (boots a local validator). The typed program is
// generated into target/types after `anchor build`.
describe("lien-score", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.LienScore as Program;
  const authority = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );

  const agent = Keypair.generate().publicKey;
  const [scorePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("lien-score"), agent.toBuffer()],
    program.programId,
  );

  it("initializes the config with the authority", async () => {
    await program.methods
      .initialize(authority.publicKey)
      .accounts({
        config: configPda,
        payer: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await (program.account as any).config.fetch(configPda);
    assert.ok(config.authority.equals(authority.publicKey));
  });

  it("writes a score to the per-agent PDA", async () => {
    await program.methods
      .setScore(agent, 782, 3, 0) // very_good, good_standing
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        score: scorePda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const score = await (program.account as any).scoreAccount.fetch(scorePda);
    assert.equal(score.score, 782);
    assert.equal(score.band, 3);
    assert.equal(score.status, 0);
    assert.ok(score.agent.equals(agent));
  });

  it("rejects an out-of-range score", async () => {
    try {
      await program.methods
        .setScore(agent, 999, 3, 0)
        .accounts({
          config: configPda,
          authority: authority.publicKey,
          score: scorePda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      assert.fail("expected ScoreOutOfRange");
    } catch (e: any) {
      assert.match(e.toString(), /ScoreOutOfRange/);
    }
  });

  it("rejects a write from a non-authority signer", async () => {
    const intruder = Keypair.generate();
    // fund the intruder so it can pay fees
    const sig = await provider.connection.requestAirdrop(intruder.publicKey, 1_000_000_000);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .setScore(agent, 700, 2, 0)
        .accounts({
          config: configPda,
          authority: intruder.publicKey,
          score: scorePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([intruder])
        .rpc();
      assert.fail("expected Unauthorized");
    } catch (e: any) {
      assert.match(e.toString(), /Unauthorized|has_one|ConstraintHasOne/);
    }
  });
});
