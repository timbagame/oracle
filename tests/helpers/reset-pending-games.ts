import type { OracleDatabase } from "../../database.ts";
import type { OracleService } from "../../oracle-service.ts";

export type ResetPendingGamesOptions = {
  service?: Pick<OracleService, "cleanupOldRecords">;
  cleanupRetention?: number;
};

export function resetPendingGames(
  db: OracleDatabase,
  options: ResetPendingGamesOptions = {},
): void {
  for (const game of db.getPendingGames(Number.POSITIVE_INFINITY)) {
    db.finalizeCompletedGame(game.game_address);
  }

  const { service, cleanupRetention = -1 } = options;
  if (service) {
    service.cleanupOldRecords(cleanupRetention);
  }
}
