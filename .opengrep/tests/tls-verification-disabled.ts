import https from "node:https";

export function bad(): void {
  // ruleid: tls-verification-disabled
  https.request({ host: "example.com", rejectUnauthorized: false });
  // ruleid: tls-verification-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export function good(ca: string): void {
  // ok: tls-verification-disabled
  https.request({ host: "example.com", ca, rejectUnauthorized: true });
  // ok: tls-verification-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
}
