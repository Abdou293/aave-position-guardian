// Detects messages that look like a private key or a seed phrase.
// This bot NEVER needs them. If a user pastes one, we warn them and try to delete the message.

/** 64 hex chars (with or without 0x) that are not part of a longer hex string. */
const PRIVATE_KEY = /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

export function looksLikeSecret(text: string): boolean {
  if (PRIVATE_KEY.test(text)) return true;
  // Seed phrase: 12–24 short lowercase words and nothing else.
  const words = text.trim().toLowerCase().split(/\s+/);
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

export const SECRET_WARNING = [
  '⛔ That looks like a PRIVATE KEY or SEED PHRASE.',
  'This bot is read-only and NEVER needs it. Nobody legitimate will ever ask you for it.',
  'I tried to delete your message, and nothing was stored.',
  'If it was real, treat it as compromised: move your funds to a new wallet as soon as possible.',
].join('\n');
