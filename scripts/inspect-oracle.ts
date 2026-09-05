import { OracleService } from "../oracle-service.ts";
import { getContractClient } from "@timbagame/protocol/contracts/client";
import { getConfig } from "../config.ts";

async function main(): Promise<void> {
  const oracleService = OracleService.getInstance();
  try {
    const programId = oracleService.getProgramId();
    const client = getContractClient(getConfig().contractVersion);
    const oraclePda = (await client.findOraclePda({ programAddress: programId }))[0];
    const account = await client.fetchOracle(oracleService.getConnection(), oraclePda, {
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
