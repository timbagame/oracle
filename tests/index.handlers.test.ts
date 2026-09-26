import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { OracleService } from "../oracle-service.ts";
import { buildHandlers, buildProductionOracleApi, shutdown } from "../index.ts";
import { logger } from "../logger.ts";
import { createBasicOracle } from "./helpers/fake-oracle.ts";

const GAME = "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function silence(method: "failure" | "warning" | "info" | "success") {
  const spy = spyOn(logger, method).mockImplementation(() => {});
  restores.push(() => spy.mockRestore());
  return spy;
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/games", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function errorOf(response: Response): Promise<[number, string]> {
  const body = (await response.json()) as { error: string };
  return [response.status, body.error];
}

const bodyHandlers = ["handleRequeueGame", "handleCompleteGameNow", "handleToggleAutoComplete"];

describe("oracle API handler edge cases", () => {
  test("requires a request for every body-reading handler", async () => {
    const handlers = buildHandlers(createBasicOracle()) as unknown as Record<
      string,
      (request?: Request) => Promise<Response>
    >;

    for (const name of bodyHandlers) {
      expect(await errorOf(await handlers[name]!())).toEqual([400, "Request body required"]);
    }
  });

  test("rejects bodies whose declared length exceeds the limit", async () => {
    const handlers = buildHandlers(createBasicOracle()) as unknown as Record<
      string,
      (request?: Request) => Promise<Response>
    >;

    for (const name of bodyHandlers) {
      const response = await handlers[name]!(post("{}", { "content-length": "10000000" }));
      expect(await errorOf(response)).toEqual([400, "Request body too large"]);
    }
  });

  test("ignores non-JSON and already consumed bodies", async () => {
    const { handleRequeueGame } = buildHandlers(createBasicOracle());
    const consumed = post(JSON.stringify({ gameAddress: GAME }));
    await consumed.text();

    const plain = await handleRequeueGame(
      post(JSON.stringify({ gameAddress: GAME }), { "content-type": "text/plain" }),
    );
    const reused = await handleRequeueGame(consumed);

    expect(await errorOf(plain)).toEqual([400, "gameAddress is required"]);
    expect(await errorOf(reused)).toEqual([400, "gameAddress is required"]);
  });

  test("hides unexpected oracle failures behind a 500", async () => {
    const failure = silence("failure");
    const boom = () => {
      throw new Error("database locked");
    };
    const handlers = buildHandlers(
      createBasicOracle({
        requeueGame: boom,
        setAutoCompleteDisabled: boom,
        queueGameCompletion: async () => boom(),
      }),
    );

    const requeue = await handlers.handleRequeueGame(post(JSON.stringify({ gameAddress: GAME })));
    const complete = await handlers.handleCompleteGameNow(
      post(JSON.stringify({ gameAddress: GAME })),
    );
    const toggle = await handlers.handleToggleAutoComplete(
      post(JSON.stringify({ gameAddress: GAME, autoCompleteDisabled: true })),
    );

    for (const response of [requeue, complete, toggle]) {
      expect(await errorOf(response)).toEqual([500, "Internal server error"]);
    }
    expect(failure.mock.calls.map(([message]) => message)).toEqual([
      "Error requeuing game:",
      "Error completing game now:",
      "Error toggling auto-complete:",
    ]);
  });

  test("reports token policies as unavailable when loading them fails", async () => {
    const failure = silence("failure");
    const { handleTokenPolicies } = buildHandlers(
      createBasicOracle({
        getTokenPolicies: async () => {
          throw new Error("rpc down");
        },
      }),
    );

    const response = await handleTokenPolicies();

    expect(await errorOf(response)).toEqual([503, "Token policies are unavailable"]);
    expect(failure).toHaveBeenCalledWith("Error loading token policies:", expect.any(Error));
  });

  test("maps every auto-complete toggle failure to its response", async () => {
    const cases = [
      ["invalid-address", 400, "gameAddress is required"],
      ["not-found", 404, "Game is not tracked"],
      ["finalized", 409, "Game is already finalized"],
      ["unchanged", 409, "Auto-complete is already set to the requested value"],
    ] as const;

    for (const [reason, status, message] of cases) {
      const { handleToggleAutoComplete } = buildHandlers(
        createBasicOracle({ setAutoCompleteDisabled: () => ({ success: false, reason }) }),
      );
      const response = await handleToggleAutoComplete(
        post(JSON.stringify({ gameAddress: GAME, autoCompleteDisabled: false })),
      );
      expect(await errorOf(response)).toEqual([status, message]);
    }
  });

  test("maps an invalid requeue address to a bad request", async () => {
    const { handleRequeueGame } = buildHandlers(
      createBasicOracle({ requeueGame: () => ({ success: false, reason: "invalid-address" }) }),
    );

    const response = await handleRequeueGame(post(JSON.stringify({ gameAddress: "nope" })));

    expect(await errorOf(response)).toEqual([400, "gameAddress is required"]);
  });

  test("forwards auto-complete toggles to the production oracle", () => {
    const calls: Array<[string, boolean]> = [];
    const api = buildProductionOracleApi({
      setAutoCompleteDisabled: (gameAddress: string, disabled: boolean) => {
        calls.push([gameAddress, disabled]);
        return { success: true, autoCompleteDisabled: disabled };
      },
    } as unknown as OracleService);

    expect(api.setAutoCompleteDisabled(GAME, true)).toEqual({
      success: true,
      autoCompleteDisabled: true,
    });
    expect(calls).toEqual([[GAME, true]]);
  });
});

describe("oracle shutdown", () => {
  test("finishes when close() throws synchronously", async () => {
    silence("info");
    silence("success");
    const warning = silence("warning");
    const oracle = createBasicOracle();
    oracle.close = () => {
      throw new Error("already closed");
    };

    await expect(shutdown(oracle, "SIGINT")).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledWith(
      "Failed to close oracle:",
      expect.objectContaining({ message: "already closed" }),
    );
  });
});
