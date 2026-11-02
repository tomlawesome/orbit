/**
 * DKIM test scaffolding (#1655): real keys, real signatures.
 *
 * Messages are signed by `mailauth`'s signer, which is test-only and shares no
 * code with the verifier under test, so a pass here is two independent
 * implementations agreeing. Keys come from `node:crypto`; the published key
 * record is built the way a DNS administrator would publish it.
 */
import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";

export type TestKey = {
  kind: "rsa" | "ed25519";
  privateKeyPem: string;
  /** The TXT record text a resolver would hand back for this key. */
  record: string;
};

function publicKeyField(kind: TestKey["kind"], spkiDer: Buffer): string {
  /* RSA publishes the SPKI DER; ed25519 (RFC 8463) publishes the raw 32 bytes,
     which are the tail of its SPKI encoding. */
  return (kind === "rsa" ? spkiDer : spkiDer.subarray(spkiDer.length - 32)).toString("base64");
}

function describeKey(kind: TestKey["kind"], publicKey: import("node:crypto").KeyObject, privateKey: import("node:crypto").KeyObject): TestKey {
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    kind,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    record: `v=DKIM1; k=${kind}; p=${publicKeyField(kind, spki)}`,
  };
}

export function makeRsaKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return describeKey("rsa", publicKey, privateKey);
}

export function makeEd25519Key(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return describeKey("ed25519", publicKey, privateKey);
}

export type SignOptions = {
  domain: string;
  selector: string;
  key: TestKey;
  /** "header/body", each "simple" or "relaxed". Default relaxed/relaxed. */
  canonicalization?: string;
  /** Header names to sign; repeating a name signs that many instances. */
  headerList?: string[];
  /** l= : sign only this many body bytes. */
  maxBodyLength?: number;
  signTime?: Date;
  expires?: Date;
};

/** Just the DKIM-Signature header line(s) (CRLF terminated) for `raw`. */
export async function signatureHeaders(raw: string, options: SignOptions): Promise<string> {
  const result = await dkimSign(Buffer.from(raw), {
    ...(options.signTime ? { signTime: options.signTime } : {}),
    ...(options.expires ? { expires: options.expires } : {}),
    signatureData: [{
      signingDomain: options.domain,
      selector: options.selector,
      privateKey: options.key.privateKeyPem,
      ...(options.canonicalization ? { canonicalization: options.canonicalization } : {}),
      ...(options.headerList ? { headerList: options.headerList } : {}),
      ...(options.maxBodyLength !== undefined ? { maxBodyLength: options.maxBodyLength } : {}),
    }],
  });
  if (result.errors.length > 0) throw new Error(`test signer failed: ${String(result.errors[0]?.err)}`);
  return result.signatures;
}

/** `raw` with a fresh signature prepended, the way a sending server delivers it. */
export async function signMessage(raw: string, options: SignOptions): Promise<Buffer> {
  return Buffer.from(`${await signatureHeaders(raw, options)}${raw}`);
}

/**
 * An ordinary forwarded message with the awkward corners canonicalisation
 * exists for: a folded header, runs of whitespace, trailing spaces on body
 * lines, a repeated header, and trailing blank lines.
 */
export function sampleMessage(options: { from?: string; body?: string } = {}): string {
  const from = options.from ?? "member@example.test";
  const body = options.body
    ?? "First line with a trailing space \r\nSecond   line\twith  tabs\r\n\r\nLast line\r\n\r\n\r\n";
  return [
    `From: Member <${from}>`,
    "To: intake@relay.example.test",
    "Subject: Fwd:  hello   world",
    "\tcontinued on a folded line",
    "Date: Mon, 02 Nov 2026 10:00:00 +0000",
    "Message-ID: <sample-1@example.test>",
    "X-Tag: one",
    "X-Tag: two",
    "",
    body,
  ].join("\r\n");
}
