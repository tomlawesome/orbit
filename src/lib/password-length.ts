/**
 * How long a password or passphrase is, and the shortest one Orbit accepts
 * (#1333). One count for every place a person sets one -- their sign-in
 * password, an export's passphrase, a recovery bundle's -- so the same typed
 * words are as long in each: NFC-normalised, one code point each, the way the
 * person counts them. A leaf with no imports, so the CLI bundle and the
 * password module can both take it without taking each other.
 *
 * The floor is held when a secret is made, never when one is opened: raising
 * it must not lock anyone out of what they made under the old one.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Code points, not UTF-16 units: an emoji is one character to the person typing it. */
export function passwordLength(password: string): number {
  return [...password.normalize("NFC")].length;
}
