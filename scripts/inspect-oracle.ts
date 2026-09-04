import { fetchOracle as fetchOracleV020 } from "@timbagame/protocol/contracts/v0.2.0/kit";
import { fetchOracle as fetchOracleV030 } from "@timbagame/protocol/contracts/v0.3.0/kit";
import { OracleService } from "../oracle-service.ts";
import { ORACLE_SEED } from "../oracle-accounts.ts";
import { derivePda } from "../solana-kit.ts";
import { getConfig } from "../config.ts";

async function main(): Promise<void> {
  const oracleService = OracleService.getInstance();
  try {
    const programId = oracleService.getProgramId();
    const oraclePda = await derivePda(programId, [ORACLE_SEED]);
    const account =
      getConfig().contractVersion === "0.2.0"
        ? await fetchOracleV020(oracleService.getConnection(), oraclePda, {
            commitment: "confirmed",
          })
        : await fetchOracleV030(oracleService.getConnection(), oraclePda, {
            commitment: "confirmed",
          });

    console.log(
      JSON.stringify(
        {
          oracleAddress: oraclePda,
          account: account.data,
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
