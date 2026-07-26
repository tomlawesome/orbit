import { createHash, generateKeyPairSync, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const issuer = "https://127.0.0.1:4443/";
const clientId = "orbit-browser-tests";
const clientSecret = "orbit-browser-tests-only-secret";
const [keyPath, certificatePath] = process.argv.slice(2);
if (!keyPath || !certificatePath) throw new Error("Expected TLS key and certificate paths");

const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = signing.publicKey.export({ format: "jwk" });
jwk.kid = "orbit-browser-test-key";
jwk.use = "sig";
jwk.alg = "RS256";

const users = new Map([
  ["administrator", { sub: "oidc-test-administrator", email: "administrator@example.test", name: "Orbit Administrator" }],
  ["member", { sub: "oidc-test-member", email: "member@example.test", name: "Orbit Member" }],
  ["outsider", { sub: "oidc-test-outsider", email: "outsider@example.test", name: "Orbit Outsider" }],
]);
const codes = new Map();

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function query(request) {
  return new URL(request.url, issuer).searchParams;
}

function responseJson(response, status, value) {
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function html(response, value) {
  response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body><main><h1>Orbit test identity</h1><p>Select the disposable identity used for this browser test.</p>${value}</main></body></html>`);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function signIdToken({ user, nonce }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuer,
    sub: user.sub,
    aud: clientId,
    exp: now + 300,
    iat: now,
    nonce,
    email: user.email,
    email_verified: true,
    name: user.name,
  }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), signing.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; if (body.length > 10_000) request.destroy(); });
    request.on("end", () => resolve(new URLSearchParams(body)));
    request.on("error", reject);
  });
}

function clientAuthenticated(request) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const supplied = Buffer.from(header.slice(6), "base64").toString("utf8");
  const expected = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

const server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, async (request, response) => {
  const url = new URL(request.url, issuer);
  if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    return responseJson(response, 200, {
      issuer,
      authorization_endpoint: `${issuer}authorize`,
      token_endpoint: `${issuer}token`,
      jwks_uri: `${issuer}jwks`,
      code_challenge_methods_supported: ["S256"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (request.method === "GET" && url.pathname === "/jwks") return responseJson(response, 200, { keys: [jwk] });
  if (request.method === "GET" && url.pathname === "/authorize") {
    const parameters = query(request);
    const redirectUri = parameters.get("redirect_uri");
    if (parameters.get("client_id") !== clientId || parameters.get("response_type") !== "code" || !redirectUri || !parameters.get("state") || !parameters.get("nonce") || !parameters.get("code_challenge")) {
      return responseJson(response, 400, { error: "invalid_request" });
    }
    const selectedUser = parameters.get("user");
    if (!selectedUser) {
      const controls = [...users.entries()].map(([id, user]) => {
        const next = new URL(url);
        next.searchParams.set("user", id);
        return `<p><a href="${next.pathname}${next.search}">${user.name}</a></p>`;
      }).join("");
      return html(response, controls);
    }
    const user = users.get(selectedUser);
    if (!user) return responseJson(response, 400, { error: "invalid_user" });
    const code = randomBytes(32).toString("base64url");
    codes.set(code, { user, nonce: parameters.get("nonce"), redirectUri, challenge: parameters.get("code_challenge") });
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", parameters.get("state"));
    return redirect(response, callback);
  }
  if (request.method === "POST" && url.pathname === "/token") {
    if (!clientAuthenticated(request)) return responseJson(response, 401, { error: "invalid_client" });
    const body = await parseBody(request);
    const entry = codes.get(body.get("code"));
    if (!entry || body.get("grant_type") !== "authorization_code" || body.get("redirect_uri") !== entry.redirectUri) return responseJson(response, 400, { error: "invalid_grant" });
    const expectedChallenge = createHash("sha256").update(body.get("code_verifier") ?? "", "utf8").digest("base64url");
    if (expectedChallenge !== entry.challenge) return responseJson(response, 400, { error: "invalid_grant" });
    codes.delete(body.get("code"));
    return responseJson(response, 200, { token_type: "Bearer", expires_in: 300, id_token: signIdToken(entry) });
  }
  return responseJson(response, 404, { error: "not_found" });
});

server.listen(4443, "127.0.0.1", () => console.log("Orbit disposable OIDC provider listening on 127.0.0.1:4443"));
