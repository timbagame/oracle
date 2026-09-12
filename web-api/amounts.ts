export const TIMBA_DECIMALS = 6;

export function tokensToAmount(amount: bigint | number, decimals: number = TIMBA_DECIMALS): number {
  const divisor = 10 ** decimals;
  if (typeof amount === "number") return amount / divisor;

  const bigintDivisor = BigInt(divisor);
  const whole = amount / bigintDivisor;
  const remainder = amount % bigintDivisor;
  return Number(whole) + Number(remainder) / divisor;
}
