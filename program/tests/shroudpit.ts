import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { Shroudpit } from "../target/types/shroudpit";

describe("shroudpit", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.shroudpit as Program<Shroudpit>;

  it("Is initialized!", async () => {
    // Add your test here.
    const tx = await program.methods.initialize().rpc();
    console.log("Your transaction signature", tx);
  });
});
