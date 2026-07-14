import { PublicKey } from "@solana/web3.js";
import { OracleService } from "../oracle-service.ts";
import { ORACLE_SEED } from "../oracle-accounts.ts";

async function main(): Promise<void> {
  const oracleService = OracleService.getInstance();
  try {
    const program = (oracleService as unknown as { program: any }).program;
    const [oraclePda] = PublicKey.findProgramAddressSync([ORACLE_SEED], program.programId);
    const account = await program.account.oracle.fetch(oraclePda);

    console.log(
      JSON.stringify(
        {
          oracleAddress: oraclePda.toBase58(),
          account,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("Failed to inspect oracle:", error);
  } finally {
    await oracleService.stopEventListening().catch(() => {});
  }
}

main();
