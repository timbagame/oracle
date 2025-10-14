import { randomUUID } from "crypto";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export type TempDatabaseFile = {
  path: string;
  cleanup: () => void;
};

export function createTempDatabaseFile(prefix: string): TempDatabaseFile {
  const filePath = join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}.sqlite`);
  return {
    path: filePath,
    cleanup: () => {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // ignore errors during cleanup to avoid masking test results
      }
    },
  };
}
