// Wallet address validation for anything a user types in (bot, dashboard, API).
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';

export type AddressParseResult =
  | { ok: true; address: Address }
  | { ok: false; reason: string };

/**
 * Accepts an EVM address and returns it in checksum form.
 * - all-lowercase or all-uppercase hex: accepted (no checksum to check), then checksummed
 * - mixed case: must have a VALID EIP-55 checksum, otherwise it is probably a typo -> rejected
 */
export function parseWalletAddress(input: string): AddressParseResult {
  const value = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { ok: false, reason: 'Not an EVM address (expected 0x followed by 40 hex characters).' };
  }
  const hex = value.slice(2);
  const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixedCase && !isAddress(value, { strict: true })) {
    return { ok: false, reason: 'Checksum does not match. The address may contain a typo.' };
  }
  const address = getAddress(value.toLowerCase());
  if (address === zeroAddress) {
    return { ok: false, reason: 'The zero address cannot be watched.' };
  }
  return { ok: true, address };
}
