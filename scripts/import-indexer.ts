import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { IndexerDatabase } from "../indexer/database.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [sourceArg, targetArg = "indexer.sqlite"] = argv;
  if (!sourceArg) {
    throw new Error("Usage: bun run indexer:import <d1-export.sql> [indexer.sqlite]");
  }

  const source = resolve(sourceArg);
  const target = resolve(targetArg);
  if (!existsSync(source)) throw new Error(`D1 export not found: ${source}`);
  if (existsSync(target)) {
    throw new Error(`Refusing to overwrite existing indexer database: ${target}`);
  }

  const temporary = `${target}.importing-${process.pid}`;
  try {
    const sqlite = new Database(temporary, { create: true, strict: true });
    try {
      sqlite.exec(await Bun.file(source).text());
      sqlite.exec("PRAGMA journal_mode = DELETE");
    } finally {
      sqlite.close();
    }

    const indexer = new IndexerDatabase(temporary);
    try {
      indexer.assertD1ImportReady();
      indexer.rebuildCaches();
    } finally {
      indexer.close();
    }
    const exported = new Database(temporary, { strict: true });
    try {
      exported.exec("PRAGMA journal_mode = DELETE");
    } finally {
      exported.close();
    }
    renameSync(temporary, target);
    console.log(`Imported D1 history into ${target}`);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${temporary}${suffix}`, { force: true });
    }
  }
}

if (import.meta.main) await main();
