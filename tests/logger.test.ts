import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../logger.ts";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];
const internals = logger as unknown as {
  config: Record<string, unknown>;
  timestampsInstalled: boolean;
  originalMethods: Map<ConsoleMethod, (...args: unknown[]) => void>;
};

let savedConsole: Array<[ConsoleMethod, (typeof console)[ConsoleMethod]]>;
let savedState: {
  config: Record<string, unknown>;
  installed: boolean;
  originals: Map<ConsoleMethod, (...args: unknown[]) => void>;
};

beforeEach(() => {
  savedConsole = METHODS.map((method) => [method, console[method]]);
  savedState = {
    config: { ...internals.config },
    installed: internals.timestampsInstalled,
    originals: new Map(internals.originalMethods),
  };
});

afterEach(() => {
  for (const [method, fn] of savedConsole) console[method] = fn as never;
  internals.config = savedState.config;
  internals.timestampsInstalled = savedState.installed;
  internals.originalMethods = savedState.originals;
});

describe("logger levels", () => {
  test("hides debug output at the default info level and shows it at debug level", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    logger.debug("hidden");
    logger.configure({ minLevel: "debug" });
    logger.debug("shown");

    expect(log.mock.calls).toEqual([["shown"]]);
  });

  test("suppresses everything when silent", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});

    logger.configure({ silent: true });
    logger.info("nope");
    logger.failure("nope");

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("prefixes progress messages", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    logger.progress("syncing", 3);

    expect(log).toHaveBeenCalledWith("🔄", "syncing", 3);
  });

  test("drops info below the configured warn level but keeps warnings", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    logger.configure({ minLevel: "warn" });
    logger.success("quiet");
    logger.warning("loud");

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("⚠️", "loud");
  });
});

describe("logger timestamps", () => {
  test("restores the original console when timestamps are disabled", () => {
    logger.configure({ timestamps: false });

    for (const method of METHODS) {
      expect(console[method]).toBe(savedState.originals.get(method) as never);
    }
    expect(internals.timestampsInstalled).toBe(false);
  });

  test("prefixes console output with an ISO timestamp when re-enabled", () => {
    logger.configure({ timestamps: false });
    const captured: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args);
    };

    logger.configure({ timestamps: true });
    console.log("hello");

    expect(captured).toHaveLength(1);
    expect(String(captured[0]![0])).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\]$/);
    expect(captured[0]![1]).toBe("hello");
  });

  test("ignores configuration that leaves timestamps unchanged", () => {
    const before = console.log;

    logger.configure({ timestamps: true });
    logger.configure({ minLevel: "info" });

    expect(console.log).toBe(before);
  });
});
