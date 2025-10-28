const ENV_KEYS = ["NODE_ENV", "BUN_ENV"] as const;

type EnvKey = (typeof ENV_KEYS)[number];

function readEnv(key: EnvKey): string | undefined {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function isCiEnvironment(): boolean {
  return process.env["CI"] === "true";
}

export function getEnvironmentMode(): string {
  for (const key of ENV_KEYS) {
    const value = readEnv(key);
    if (value) {
      return value;
    }
  }

  if (isCiEnvironment()) {
    return "ci";
  }

  return "development";
}

export function isTestEnvironment(): boolean {
  const mode = getEnvironmentMode().toLowerCase();
  return mode === "test" || mode.includes("test");
}

export function shouldUseEphemeralKeypair(): boolean {
  if (isTestEnvironment()) {
    return true;
  }

  if (isCiEnvironment()) {
    return true;
  }

  return process.env["USE_FAKE_KEYPAIR"] === "true";
}
