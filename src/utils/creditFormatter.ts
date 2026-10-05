/**
 * Format credit units (1 credit = 1000 units) to user-friendly string.
 *
 * Rules:
 * - 20000 units -> "20"
 * - 20500 units -> "20.5"
 * - 20250 units -> "20.25"
 * - 0 units -> "0"
 * - Never shows unnecessary trailing decimals like 20.0000.
 */
export function formatCredits(units: number | null | undefined): string {
  if (units === null || units === undefined || !Number.isFinite(units)) {
    return '0';
  }
  const credits = units / 1000;
  // Format with at most 3 decimal places and strip trailing zeros
  return parseFloat(credits.toFixed(3)).toLocaleString('vi-VN', {
    maximumFractionDigits: 3,
  });
}

export function unitsToCredits(units: number): number {
  if (!Number.isFinite(units)) return 0;
  return Number((units / 1000).toFixed(3));
}
