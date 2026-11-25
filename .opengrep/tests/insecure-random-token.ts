export function makeToken(): string {
  // ruleid: insecure-random-token
  return Math.random().toString(36).slice(2);
}

// ruleid: insecure-random-token
const sessionId = Math.floor(Math.random() * 1e9);

// ruleid: insecure-random-token
export const record = { apiKey: Math.random().toString(16) };

// ok: insecure-random-token
const jitterMs = Math.random() * 250;

// ok: insecure-random-token
const validFraction = Math.random();

export function pickColour(): number {
  // ok: insecure-random-token
  return Math.floor(Math.random() * 8);
}

export const used = [sessionId, jitterMs, validFraction];
