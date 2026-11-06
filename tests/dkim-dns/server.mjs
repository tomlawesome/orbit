/**
 * The e2e stack's DKIM key stand-in (#1681): a UDP DNS responder that knows
 * one name. Orbit's DKIM key lookup is pointed at it with
 * MAIL_IN_DKIM_DNS_SERVERS (compose/docker-compose.acceptance.yml).
 *
 *   DKIM_SELECTOR, DKIM_DOMAIN   the one name it answers, `selector._domainkey.domain`;
 *   DKIM_RECORD_FILE             the TXT record text (one trailing newline is dropped);
 *   DKIM_DNS_PORT                the UDP port, 5353 by default (unprivileged).
 *
 * TXT for that name answers the record, split into strings of at most 255
 * bytes (RFC 1035 3.3.14; a 2048-bit key needs two). Any other type for it is
 * an empty NOERROR answer. Every other name is NXDOMAIN, so a wrong selector
 * reads as "no key", never as a temporary failure. Nothing is forwarded.
 * Test-only: never part of a deployment.
 */
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";

const selector = required("DKIM_SELECTOR");
const domain = required("DKIM_DOMAIN");
const recordFile = required("DKIM_RECORD_FILE");
const port = Number(process.env.DKIM_DNS_PORT ?? 5353);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`DKIM_DNS_PORT is not a port: ${process.env.DKIM_DNS_PORT}`);

const NAME = `${selector}._domainkey.${domain}`.toLowerCase().replace(/\.$/u, "");
const RECORD = Buffer.from(readFileSync(recordFile, "utf8").replace(/\r?\n$/u, ""), "utf8");
if (RECORD.length === 0) throw new Error(`${recordFile} is empty`);

const TYPE_TXT = 16;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const RCODE = { noError: 0, formErr: 1, nxDomain: 3, notImp: 4 };
/* Classic DNS over UDP without EDNS (RFC 1035 4.2.1). */
const MAX_UDP_BYTES = 512;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The record as TXT RDATA: length-prefixed strings of at most 255 bytes. */
function txtRdata(record) {
  const parts = [];
  for (let offset = 0; offset < record.length; offset += 255) {
    const chunk = record.subarray(offset, offset + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
  }
  return Buffer.concat(parts);
}
const RDATA = txtRdata(RECORD);

/** The question section: its name (lower case, no trailing dot), type, class, and where it ends. Throws on anything malformed. */
function parseQuestion(query) {
  const labels = [];
  let offset = 12;
  for (;;) {
    if (offset >= query.length) throw new Error("truncated name");
    const length = query[offset];
    if (length === 0) { offset += 1; break; }
    /* A query's own name never needs compression; anything else is malformed. */
    if (length > 63) throw new Error("bad label");
    const end = offset + 1 + length;
    if (end > query.length) throw new Error("truncated label");
    labels.push(query.subarray(offset + 1, end).toString("latin1").toLowerCase());
    offset = end;
  }
  if (offset + 4 > query.length) throw new Error("truncated question");
  return { name: labels.join("."), type: query.readUInt16BE(offset), qclass: query.readUInt16BE(offset + 2), end: offset + 4 };
}

function header(query, { rcode, answers, truncated = false, questions = 1 }) {
  const out = Buffer.alloc(12);
  query.copy(out, 0, 0, 2); // ID
  const opcode = (query[2] >> 3) & 0x0f;
  const recursionDesired = query[2] & 0x01;
  out[2] = 0x80 | (opcode << 3) | 0x04 /* AA */ | (truncated ? 0x02 : 0) | recursionDesired;
  out[3] = rcode & 0x0f; // RA = 0: nothing is forwarded.
  out.writeUInt16BE(questions, 4);
  out.writeUInt16BE(answers, 6);
  return out;
}

/** The response to one datagram, or nothing when it is not worth answering. */
function respond(query) {
  if (query.length < 12 || query[2] & 0x80) return undefined; // too short, or itself a response
  if (query.readUInt16BE(4) !== 1) return header(query, { rcode: RCODE.formErr, answers: 0, questions: 0 });
  const opcode = (query[2] >> 3) & 0x0f;
  let question;
  try {
    question = parseQuestion(query);
  } catch {
    return header(query, { rcode: RCODE.formErr, answers: 0, questions: 0 });
  }
  const questionBytes = query.subarray(12, question.end);
  if (opcode !== 0) return Buffer.concat([header(query, { rcode: RCODE.notImp, answers: 0 }), questionBytes]);
  if (question.name !== NAME) return Buffer.concat([header(query, { rcode: RCODE.nxDomain, answers: 0 }), questionBytes]);
  const wantsTxt = (question.type === TYPE_TXT || question.type === TYPE_ANY) && (question.qclass === CLASS_IN || question.qclass === TYPE_ANY);
  if (!wantsTxt) return Buffer.concat([header(query, { rcode: RCODE.noError, answers: 0 }), questionBytes]);
  const answer = Buffer.alloc(12);
  answer.writeUInt16BE(0xc00c, 0); // the name, as a pointer to the question's
  answer.writeUInt16BE(TYPE_TXT, 2);
  answer.writeUInt16BE(CLASS_IN, 4);
  answer.writeUInt32BE(60, 6); // TTL
  answer.writeUInt16BE(RDATA.length, 10);
  const full = Buffer.concat([header(query, { rcode: RCODE.noError, answers: 1 }), questionBytes, answer, RDATA]);
  if (full.length <= MAX_UDP_BYTES) return full;
  return Buffer.concat([header(query, { rcode: RCODE.noError, answers: 0, truncated: true }), questionBytes]);
}

const socket = createSocket("udp4");
socket.on("message", (query, peer) => {
  const response = respond(query);
  if (response) socket.send(response, peer.port, peer.address);
});
socket.on("error", (error) => {
  console.error(`orbit-dkim-dns: ${error.message}`);
  process.exit(1);
});
socket.bind(port, "0.0.0.0", () => {
  console.log(`orbit-dkim-dns: answering TXT for ${NAME} on udp/${port}`);
});
/* PID 1 in its container: without these, `docker stop` waits out its timeout. */
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => socket.close(() => process.exit(0)));
