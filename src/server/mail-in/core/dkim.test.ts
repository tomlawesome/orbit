import { createHash, createPrivateKey, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dkimPublicKeyFromRecord,
  parseDkimSignatures,
  verifyDkimSignature,
  type DkimSignature,
} from "./dkim";
import {
  makeEd25519Key,
  makeRsaKey,
  sampleMessage,
  signatureHeaders,
  signMessage,
  type TestKey,
} from "../../../../tests/support/dkim-signing";

const RSA = makeRsaKey();
const RSA_PRIVATE_KEY = createPrivateKey(RSA.privateKeyPem);
const OTHER_RSA = makeRsaKey();
const ED = makeEd25519Key();
const DOMAIN = "example.test";
const SELECTOR = "s1";

/** Parses the topmost signature of `raw` and verifies it against `record`. */
function verifyTop(raw: Buffer, record: string | undefined, now?: Date) {
  const [signature] = parseDkimSignatures(raw);
  expect(signature).toBeDefined();
  const key = record === undefined ? undefined : dkimPublicKeyFromRecord(record);
  return verifyDkimSignature(raw, signature!, key, now);
}

const CANONS = ["simple/simple", "simple/relaxed", "relaxed/simple", "relaxed/relaxed"] as const;

/* ---- RFC 6376 Appendix A vector (the worked example, verbatim) ---------- */
const RFC6376_A_KEY_RECORD =
  "v=DKIM1; k=rsa; "
  + "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDwIRP/UC3SBsEmGqZ9ZJW3/DkM"
  + "oGeLnQg1fWn7/zYtIxN2SnFCjxOCKG9v3b4jYfcTNh5ijSsq631uBItLa7od+v/RtdC2UzJ1lWT947qR+Rcac2gb"
  + "to/NMqJ0fzfVjH4OuKhitdY9tf6mcwGjaNBcWToIMmPSPDdQPNUYckcQ2QIDAQAB";

const RFC6376_A_MESSAGE = [
  "DKIM-Signature: v=1; a=rsa-sha256; s=brisbane; d=example.com;",
  "      c=simple/simple; q=dns/txt; i=joe@football.example.com;",
  "      h=Received : From : To : Subject : Date : Message-ID;",
  "      bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;",
  "      b=AuUoFEfDxTDkHlLXSZEpZj79LICEps6eda7W3deTVFOk4yAUoqOB",
  "        4nujc7YopdG5dWLSdNg6xNAZpOPr+kHxt1IrE+NahM6L/LbvaHut",
  "        KVdkLLkpVaVVQPzeRDI009SO2Il5Lu7rDNH6mZckBdrIx0orEtZV",
  "        4bmp/YzhwvcubU4=;",
  "Received: from client1.football.example.com  [192.0.2.1]",
  "      by submitserver.example.com with SUBMISSION;",
  "      Fri, 11 Jul 2003 21:01:54 -0700 (PDT)",
  "From: Joe SixPack <joe@football.example.com>",
  "To: Suzie Q <suzie@shopping.example.net>",
  "Subject: Is dinner ready?",
  "Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)",
  "Message-ID: <20030712040037.46341.5F8J@football.example.com>",
  "",
  "Hi.",
  "",
  "We lost the game. Are you hungry yet?",
  "",
  "Joe.",
  "",
].join("\r\n");

describe("RFC 6376 Appendix A vector", () => {
  const raw = Buffer.from(RFC6376_A_MESSAGE);

  it("parses the published signature", () => {
    const signatures = parseDkimSignatures(raw);
    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({
      domain: "example.com",
      selector: "brisbane",
      algorithm: "rsa-sha256",
      headerCanon: "simple",
      bodyCanon: "simple",
      signedHeaders: ["received", "from", "to", "subject", "date", "message-id"],
      bodyHash: "2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=",
      headerIndex: 0,
    });
    expect(signatures[0]!.signature).toMatch(/^AuUoFEfDxTDkHlLXSZEpZj79LICEps6eda7W3deTVFOk4yAUoqOB4nujc7/);
    expect(signatures[0]!.signature).not.toMatch(/\s/u);
  });

  it("verifies with the published key", () => {
    expect(verifyTop(raw, RFC6376_A_KEY_RECORD)).toEqual({ ok: true, domain: "example.com" });
  });

  it("verifies the same message delivered with bare LF line endings", () => {
    expect(verifyTop(Buffer.from(RFC6376_A_MESSAGE.replace(/\r\n/gu, "\n")), RFC6376_A_KEY_RECORD))
      .toEqual({ ok: true, domain: "example.com" });
  });

  it("rejects the vector once its body or a signed header is altered", () => {
    expect(verifyTop(Buffer.from(RFC6376_A_MESSAGE.replace("Joe.", "Jim.")), RFC6376_A_KEY_RECORD))
      .toEqual({ ok: false, reason: "body_hash_mismatch" });
    expect(verifyTop(Buffer.from(RFC6376_A_MESSAGE.replace("Is dinner ready?", "Is lunch ready?")), RFC6376_A_KEY_RECORD))
      .toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("reports a missing key", () => {
    expect(verifyTop(raw, undefined)).toEqual({ ok: false, reason: "key_missing" });
  });
});

/* ---- parseDkimSignatures ------------------------------------------------ */
describe("parseDkimSignatures", () => {
  const handBuilt = (tags: string, extra = "") =>
    `DKIM-Signature: ${tags}\r\n${extra}From: a@example.test\r\n\r\nbody\r\n`;
  const GOOD_TAGS = "v=1; a=rsa-sha256; d=Example.TEST; s=sel; c=relaxed/simple;\r\n"
    + " h=From:SUBJECT:from; bh=AAAA; b=Zm9v\r\n YmFy; l=5; t=100; x=200";

  it("reads every tag, case-folding the domain and header names and joining a folded b=", () => {
    const [signature] = parseDkimSignatures(Buffer.from(handBuilt(GOOD_TAGS)));
    expect(signature).toEqual({
      domain: "example.test",
      selector: "sel",
      algorithm: "rsa-sha256",
      headerCanon: "relaxed",
      bodyCanon: "simple",
      signedHeaders: ["from", "subject", "from"],
      bodyHash: "AAAA",
      signature: "Zm9vYmFy",
      bodyLength: 5,
      timestamp: 100,
      expires: 200,
      headerIndex: 0,
    } satisfies DkimSignature);
  });

  it("defaults the canonicalisation to simple/simple, and a lone header half leaves the body simple", () => {
    const base = "v=1; a=ed25519-sha256; d=example.test; s=sel; h=from; bh=AAAA; b=Zm9v";
    expect(parseDkimSignatures(Buffer.from(handBuilt(base)))[0]).toMatchObject({
      algorithm: "ed25519-sha256", headerCanon: "simple", bodyCanon: "simple",
    });
    expect(parseDkimSignatures(Buffer.from(handBuilt(`${base}; c=relaxed`)))[0]).toMatchObject({
      headerCanon: "relaxed", bodyCanon: "simple",
    });
    expect(parseDkimSignatures(Buffer.from(handBuilt(`${base}; c=relaxed/relaxed`)))[0]).toMatchObject({
      headerCanon: "relaxed", bodyCanon: "relaxed",
    });
  });

  it("matches the header name in any case", () => {
    const raw = Buffer.from(handBuilt(GOOD_TAGS).replace("DKIM-Signature", "dkim-SIGNATURE"));
    expect(parseDkimSignatures(raw)).toHaveLength(1);
  });

  it("skips what it cannot use instead of throwing", () => {
    const bad = [
      GOOD_TAGS.replace("v=1", "v=2"),
      GOOD_TAGS.replace("a=rsa-sha256", "a=rsa-sha1"),
      GOOD_TAGS.replace("a=rsa-sha256", "a=nonsense"),
      GOOD_TAGS.replace("c=relaxed/simple", "c=bogus/simple"),
      GOOD_TAGS.replace("c=relaxed/simple", "c=simple/bogus"),
      `${GOOD_TAGS}; q=other/thing`,
      GOOD_TAGS.replace("d=Example.TEST;", ""),
      GOOD_TAGS.replace("s=sel;", ""),
      GOOD_TAGS.replace(/ b=Zm9v\r\n YmFy;/u, ""),
      GOOD_TAGS.replace("bh=AAAA;", ""),
      GOOD_TAGS.replace(/ h=From:SUBJECT:from;/u, ""),
      "this is not a tag list at all",
      "",
    ];
    for (const tags of bad) {
      expect(parseDkimSignatures(Buffer.from(handBuilt(tags))), tags).toEqual([]);
    }
  });

  it("keeps the usable signatures around an unusable one, numbering by position in the message", () => {
    const raw = Buffer.from(
      `DKIM-Signature: v=2; garbage\r\nDKIM-Signature: ${GOOD_TAGS}\r\nFrom: a@example.test\r\n\r\nbody\r\n`,
    );
    const signatures = parseDkimSignatures(raw);
    expect(signatures).toHaveLength(1);
    expect(signatures[0]).toMatchObject({ domain: "example.test", headerIndex: 1 });
  });

  it("returns at most ten, topmost first", () => {
    const many = Array.from({ length: 12 }, (_, i) => `DKIM-Signature: ${GOOD_TAGS.replace("s=sel", `s=sel${i}`)}\r\n`).join("");
    const signatures = parseDkimSignatures(Buffer.from(`${many}From: a@example.test\r\n\r\nbody\r\n`));
    expect(signatures).toHaveLength(10);
    expect(signatures.map((s) => s.selector)).toEqual(Array.from({ length: 10 }, (_, i) => `sel${i}`));
    expect(signatures.map((s) => s.headerIndex)).toEqual(Array.from({ length: 10 }, (_, i) => i));
  });

  it("does not read a DKIM-Signature line that sits in the body", () => {
    const raw = Buffer.from(`From: a@example.test\r\n\r\nDKIM-Signature: ${GOOD_TAGS}\r\n`);
    expect(parseDkimSignatures(raw)).toEqual([]);
  });

  it("finds nothing in a message with no signature, or in no message", () => {
    expect(parseDkimSignatures(Buffer.from("From: a@example.test\r\n\r\nbody\r\n"))).toEqual([]);
    expect(parseDkimSignatures(Buffer.alloc(0))).toEqual([]);
  });

  it("reads the signature a real signer wrote", async () => {
    const raw = await signMessage(sampleMessage(), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization: "relaxed/simple",
    });
    const [signature] = parseDkimSignatures(raw);
    expect(signature).toMatchObject({
      domain: DOMAIN, selector: SELECTOR, algorithm: "rsa-sha256",
      headerCanon: "relaxed", bodyCanon: "simple", headerIndex: 0,
    });
    expect(signature!.signedHeaders).toContain("from");
    expect(signature!.signature).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(signature!.bodyHash).toMatch(/^[A-Za-z0-9+/]+=*$/u);
  });
});

/* ---- dkimPublicKeyFromRecord -------------------------------------------- */
describe("dkimPublicKeyFromRecord", () => {
  const rsaP = RSA.record.slice(RSA.record.indexOf("p="));
  const edP = ED.record.slice(ED.record.indexOf("p="));

  it("reads an RSA key and an ed25519 key", () => {
    expect(dkimPublicKeyFromRecord(RSA.record)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(ED.record)?.asymmetricKeyType).toBe("ed25519");
  });

  it("treats v and k as optional, defaulting to DKIM1 and rsa", () => {
    expect(dkimPublicKeyFromRecord(rsaP)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(`k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(`v=DKIM1; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
  });

  it("tolerates whitespace around tags and a trailing semicolon", () => {
    expect(dkimPublicKeyFromRecord(`v=DKIM1 ; k=rsa ;  ${rsaP} ;`)?.asymmetricKeyType).toBe("rsa");
  });

  it("refuses a revoked key (empty p)", () => {
    expect(dkimPublicKeyFromRecord("v=DKIM1; k=rsa; p=")).toBeUndefined();
    expect(dkimPublicKeyFromRecord("v=DKIM1; k=ed25519; p=;")).toBeUndefined();
  });

  it("refuses a key type it does not know, a different version, and bad base64", () => {
    expect(dkimPublicKeyFromRecord(`v=DKIM1; k=unknown; ${rsaP}`)).toBeUndefined();
    expect(dkimPublicKeyFromRecord(`v=DKIM2; k=rsa; ${rsaP}`)).toBeUndefined();
    expect(dkimPublicKeyFromRecord("v=DKIM1; k=rsa; p=!!!not-base64!!!")).toBeUndefined();
    expect(dkimPublicKeyFromRecord("v=DKIM1; k=rsa; p=AAAA")).toBeUndefined();
    expect(dkimPublicKeyFromRecord("")).toBeUndefined();
    expect(dkimPublicKeyFromRecord("v=spf1 -all")).toBeUndefined();
  });

  it("refuses a key limited to sha1 and accepts one that allows sha256", () => {
    expect(dkimPublicKeyFromRecord(`v=DKIM1; h=sha1; k=rsa; ${rsaP}`)).toBeUndefined();
    expect(dkimPublicKeyFromRecord(`v=DKIM1; h=sha256; k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(`v=DKIM1; h=sha1:sha256; k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
  });

  it("refuses a key restricted to a service other than email", () => {
    expect(dkimPublicKeyFromRecord(`v=DKIM1; s=web; k=rsa; ${rsaP}`)).toBeUndefined();
    expect(dkimPublicKeyFromRecord(`v=DKIM1; s=*; k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(`v=DKIM1; s=email; k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(`v=DKIM1; s=web:email; k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
  });

  it("still returns a key flagged as testing (t=y)", () => {
    expect(dkimPublicKeyFromRecord(`v=DKIM1; t=y; k=rsa; ${rsaP}`)?.asymmetricKeyType).toBe("rsa");
    expect(dkimPublicKeyFromRecord(`v=DKIM1; t=y; k=ed25519; ${edP}`)?.asymmetricKeyType).toBe("ed25519");
  });
});

/* ---- verifyDkimSignature ------------------------------------------------ */
describe("verifyDkimSignature: signatures made by a real signer", () => {
  const keys: Array<[string, TestKey]> = [["rsa-sha256", RSA], ["ed25519-sha256", ED]];

  for (const [algorithm, key] of keys) {
    for (const canonicalization of CANONS) {
      it(`${algorithm} with c=${canonicalization} verifies`, async () => {
        const raw = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key, canonicalization });
        const [signature] = parseDkimSignatures(raw);
        expect(signature!.algorithm).toBe(algorithm);
        expect(signature!.headerCanon).toBe(canonicalization.split("/")[0]);
        expect(signature!.bodyCanon).toBe(canonicalization.split("/")[1]);
        expect(verifyTop(raw, key.record)).toEqual({ ok: true, domain: DOMAIN });
      });
    }
  }

  it.each(CANONS)("verifies a message with an empty body under c=%s", async (canonicalization) => {
    const raw = await signMessage(sampleMessage({ body: "" }), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization,
    });
    expect(verifyTop(raw, RSA.record)).toEqual({ ok: true, domain: DOMAIN });
  });

  it.each(CANONS)("verifies the same message delivered with bare LF line endings under c=%s", async (canonicalization) => {
    const crlf = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization });
    const lf = Buffer.from(crlf.toString("latin1").replace(/\r\n/gu, "\n"), "latin1");
    expect(lf.includes(0x0d)).toBe(false);
    expect(verifyTop(lf, RSA.record)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("verifies a message whose repeated header is signed once per instance", async () => {
    const raw = await signMessage(sampleMessage(), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization: "relaxed/relaxed",
      headerList: ["from", "subject", "x-tag", "x-tag"],
    });
    const [signature] = parseDkimSignatures(raw);
    expect(signature!.signedHeaders.filter((name) => name === "x-tag")).toHaveLength(2);
    expect(verifyTop(raw, RSA.record)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("matches a repeated header from the bottom up (RFC 6376 section 5.4.2)", () => {
    /* A signature naming x-tag once covers the LOWEST x-tag. mailauth always
       signs every instance, so this one is signed by hand. */
    const body = "Hello there.\r\n";
    const bodyHash = createHash("sha256").update(body).digest("base64");
    const tags = `v=1; a=rsa-sha256; d=${DOMAIN}; s=${SELECTOR}; c=simple/simple; h=from:x-tag; bh=${bodyHash}; b=`;
    const fromLine = "From: member@example.test";
    const signed = createSign("sha256")
      .update(`${fromLine}\r\nX-Tag: two\r\nDKIM-Signature: ${tags}`)
      .sign(RSA_PRIVATE_KEY, "base64");
    const build = (upper: string, lower: string) => Buffer.from(
      `DKIM-Signature: ${tags}${signed}\r\n${fromLine}\r\nX-Tag: ${upper}\r\nX-Tag: ${lower}\r\n\r\n${body}`,
    );
    expect(verifyTop(build("one", "two"), RSA.record)).toEqual({ ok: true, domain: DOMAIN });
    /* The upper instance is not covered; the lower one is. */
    expect(verifyTop(build("changed", "two"), RSA.record)).toEqual({ ok: true, domain: DOMAIN });
    expect(verifyTop(build("one", "changed"), RSA.record)).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("tolerates whitespace changes under relaxed canonicalisation but not under simple", async () => {
    const relaxed = await signMessage(sampleMessage(), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization: "relaxed/relaxed",
    });
    const respaced = Buffer.from(relaxed.toString()
      .replace("Subject: Fwd:  hello   world", "Subject:   Fwd: hello world  ")
      .replace("Second   line", "Second line"));
    expect(verifyTop(respaced, RSA.record)).toEqual({ ok: true, domain: DOMAIN });

    const simple = await signMessage(sampleMessage(), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization: "simple/simple",
    });
    const respacedSimple = Buffer.from(simple.toString().replace("Second   line", "Second line"));
    expect(verifyTop(respacedSimple, RSA.record)).toEqual({ ok: false, reason: "body_hash_mismatch" });
  });

  it("rejects a tampered body", async () => {
    const raw = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA });
    const tampered = Buffer.from(raw.toString().replace("Last line", "Another line"));
    expect(verifyTop(tampered, RSA.record)).toEqual({ ok: false, reason: "body_hash_mismatch" });
  });

  it("rejects a tampered signed header", async () => {
    const raw = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA });
    const tampered = Buffer.from(raw.toString().replace("Message-ID: <sample-1@", "Message-ID: <sample-2@"));
    expect(verifyTop(tampered, RSA.record)).toEqual({ ok: false, reason: "signature_invalid" });
    const forged = Buffer.from(raw.toString().replace("From: Member <member@example.test>", "From: Member <other@example.test>"));
    expect(verifyTop(forged, RSA.record)).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("does not mind a header the signature does not cover being changed", async () => {
    const raw = await signMessage(sampleMessage(), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, headerList: ["from", "subject"],
    });
    const changed = Buffer.from(raw.toString().replace("Date: Mon, 02 Nov 2026", "Date: Tue, 03 Nov 2026"));
    expect(verifyTop(changed, RSA.record)).toEqual({ ok: true, domain: DOMAIN });
  });

  it("refuses a signature that does not cover From", async () => {
    /* The signer refuses to leave From out, so take it out of h= afterwards. The
       From check comes before any hashing, so the stale b= is never reached. */
    const signed = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA });
    const raw = Buffer.from(signed.toString().replace(/\bh=[^;]*;/u, "h=subject:to;"));
    const [signature] = parseDkimSignatures(raw);
    expect(signature!.signedHeaders).toEqual(["subject", "to"]);
    expect(verifyTop(raw, RSA.record)).toEqual({ ok: false, reason: "from_not_signed" });
  });

  it("refuses a signature that has expired, and accepts it before then", async () => {
    const raw = await signMessage(sampleMessage(), {
      domain: DOMAIN, selector: SELECTOR, key: RSA,
      signTime: new Date("2026-01-01T00:00:00Z"), expires: new Date("2026-01-02T00:00:00Z"),
    });
    const [signature] = parseDkimSignatures(raw);
    expect(signature!.expires).toBe(Date.parse("2026-01-02T00:00:00Z") / 1000);
    expect(verifyTop(raw, RSA.record, new Date("2026-01-01T12:00:00Z"))).toEqual({ ok: true, domain: DOMAIN });
    expect(verifyTop(raw, RSA.record, new Date("2026-01-03T00:00:00Z"))).toEqual({ ok: false, reason: "expired" });
    /* Default `now` is the real clock, which is long past 2026-01-02. */
    expect(verifyTop(raw, RSA.record)).toEqual({ ok: false, reason: "expired" });
  });

  it("reports a missing key", async () => {
    const raw = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA });
    expect(verifyTop(raw, undefined)).toEqual({ ok: false, reason: "key_missing" });
    expect(verifyTop(raw, "v=DKIM1; k=rsa; p=")).toEqual({ ok: false, reason: "key_missing" });
  });

  it("refuses a key of the wrong type for the signature's algorithm", async () => {
    const rsaSigned = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA });
    const edSigned = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: ED });
    expect(verifyTop(rsaSigned, ED.record)).toEqual({ ok: false, reason: "unsupported" });
    expect(verifyTop(edSigned, RSA.record)).toEqual({ ok: false, reason: "unsupported" });
  });

  it("refuses a different key of the right type", async () => {
    const raw = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: RSA });
    expect(verifyTop(raw, OTHER_RSA.record)).toEqual({ ok: false, reason: "signature_invalid" });
    const edRaw = await signMessage(sampleMessage(), { domain: DOMAIN, selector: SELECTOR, key: ED });
    expect(verifyTop(edRaw, makeEd25519Key().record)).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("honours l=: appended text is ignored, a change inside the signed prefix is not", async () => {
    const body = "0123456789 the signed prefix ends before this sentence.\r\n";
    const raw = await signMessage(sampleMessage({ body }), {
      domain: DOMAIN, selector: SELECTOR, key: RSA, canonicalization: "relaxed/simple", maxBodyLength: 10,
    });
    const [signature] = parseDkimSignatures(raw);
    expect(signature!.bodyLength).toBe(10);
    expect(verifyTop(raw, RSA.record)).toEqual({ ok: true, domain: DOMAIN });

    const appended = Buffer.from(`${raw.toString()}An unsigned addition.\r\n`);
    expect(verifyTop(appended, RSA.record)).toEqual({ ok: true, domain: DOMAIN });
    const rewrittenTail = Buffer.from(raw.toString().replace("this sentence", "that sentence"));
    expect(verifyTop(rewrittenTail, RSA.record)).toEqual({ ok: true, domain: DOMAIN });

    const insidePrefix = Buffer.from(raw.toString().replace("0123456789", "0123456780"));
    expect(verifyTop(insidePrefix, RSA.record)).toEqual({ ok: false, reason: "body_hash_mismatch" });
  });

  it("verifies the second signature when only the first is broken", async () => {
    const raw = sampleMessage();
    const first = await signatureHeaders(raw, { domain: DOMAIN, selector: "first", key: RSA });
    const second = await signatureHeaders(raw, { domain: "other.test", selector: "second", key: ED });
    /* Damage the first signature's b= value: flip its first character. */
    const broken = first.replace(/(\sb=)(.)/u, (_m, tag: string, ch: string) => `${tag}${ch === "A" ? "B" : "A"}`);
    expect(broken).not.toBe(first);
    const message = Buffer.from(`${broken}${second}${raw}`);

    const signatures = parseDkimSignatures(message);
    expect(signatures.map((s) => [s.selector, s.headerIndex])).toEqual([["first", 0], ["second", 1]]);
    expect(verifyDkimSignature(message, signatures[0]!, dkimPublicKeyFromRecord(RSA.record)))
      .toEqual({ ok: false, reason: "signature_invalid" });
    expect(verifyDkimSignature(message, signatures[1]!, dkimPublicKeyFromRecord(ED.record)))
      .toEqual({ ok: true, domain: "other.test" });
  });

  it("verifies each of two signatures that are both good, whichever the other one is", async () => {
    const raw = sampleMessage();
    const first = await signatureHeaders(raw, { domain: DOMAIN, selector: "first", key: RSA, canonicalization: "simple/simple" });
    const second = await signatureHeaders(raw, { domain: DOMAIN, selector: "second", key: ED, canonicalization: "relaxed/relaxed" });
    const message = Buffer.from(`${first}${second}${raw}`);
    const [a, b] = parseDkimSignatures(message);
    expect(verifyDkimSignature(message, a!, dkimPublicKeyFromRecord(RSA.record))).toEqual({ ok: true, domain: DOMAIN });
    expect(verifyDkimSignature(message, b!, dkimPublicKeyFromRecord(ED.record))).toEqual({ ok: true, domain: DOMAIN });
  });
});
