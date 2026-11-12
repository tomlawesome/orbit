import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { PROCESS_DEADLINE_MS } from "../process-budget.mjs";

/*
 * A fake of the part of GitHub's REST API the release-handoff scripts use
 * (#1824): releases (list, create, read, delete), release assets (upload on
 * the uploads host, list, download, delete). It behaves like the real one where
 * that matters to a caller:
 *  - the list is paginated (30 per page unless per_page says otherwise);
 *  - GET /releases/tags/<tag> never shows a draft;
 *  - uploading an asset whose name is already on the release is a 422;
 *  - an asset's API url gives JSON unless asked for application/octet-stream;
 *  - every API and uploads call needs the token.
 * The API lives under /api and the uploads host under /uploads, so a script
 * that mixes them up fails. Every request is recorded in `requests`.
 *
 * The server runs in the test's own process, so a script must be run with
 * runScript (async), never spawnSync, or the server could not answer.
 */
export const FAKE_TOKEN = "fake-token-for-tests";
export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export class FakeGithub {
  constructor({ repository = "example-owner/example-repo", token = FAKE_TOKEN } = {}) {
    this.repository = repository;
    this.token = token;
    this.releases = [];
    this.requests = [];
    this.uploads = [];
    this.deleted = [];
    this.nextId = 1000;
    // (record) => status code to answer with instead of handling, or undefined.
    this.failWhen = () => undefined;
    // (record, server) => void, called before each request is handled.
    this.onRequest = () => undefined;
  }

  async start() {
    this.server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    this.apiUrl = `${this.base}/api`;
    this.uploadsUrl = `${this.base}/uploads`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  get prefix() {
    return `/repos/${this.repository}`;
  }

  addRelease({ tag_name, name = tag_name, draft = true, created_at = new Date().toISOString(), assets = [] }) {
    const release = { id: this.nextId++, tag_name, name, draft, created_at, assets: [] };
    this.releases.push(release);
    for (const asset of assets) this.addAsset(release, asset.name, asset.content);
    return release;
  }

  addAsset(release, name, content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const asset = { id: this.nextId++, name, content: buffer };
    release.assets.push(asset);
    return asset;
  }

  draftsFor(tag) {
    return this.releases.filter((r) => r.tag_name === tag && r.draft);
  }

  assetJson(asset) {
    return {
      id: asset.id,
      name: asset.name,
      size: asset.content.length,
      state: "uploaded",
      url: `${this.apiUrl}${this.prefix}/releases/assets/${asset.id}`,
      browser_download_url: `${this.base}/dl/${asset.id}/${encodeURIComponent(asset.name)}`,
    };
  }

  releaseJson(r) {
    return {
      id: r.id,
      tag_name: r.tag_name,
      name: r.name,
      draft: r.draft,
      created_at: r.created_at,
      url: `${this.apiUrl}${this.prefix}/releases/${r.id}`,
      upload_url: `${this.uploadsUrl}${this.prefix}/releases/${r.id}/assets{?name,label}`,
      assets: r.assets.map((a) => this.assetJson(a)),
    };
  }

  page(items, query) {
    const per = Math.min(Number(query.get("per_page") ?? 30), 100);
    const page = Number(query.get("page") ?? 1);
    return items.slice((page - 1) * per, page * per);
  }

  handle(req, res, body) {
    const url = new URL(req.url, "http://fake");
    const record = {
      seq: this.requests.length,
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      authorized: [`Bearer ${this.token}`, `token ${this.token}`].includes(req.headers.authorization ?? ""),
      accept: req.headers.accept ?? "",
      bodyLength: body.length,
    };
    this.requests.push(record);
    const send = (status, json) => {
      record.status = status;
      if (json === undefined) {
        res.writeHead(status);
        res.end();
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      }
    };
    this.onRequest(record, this);
    const injected = this.failWhen(record, body);
    if (injected !== undefined) return send(injected, { message: "injected failure" });

    const download = /^\/dl\/(\d+)\//u.exec(url.pathname);
    if (download) {
      const asset = this.releases.flatMap((r) => r.assets).find((a) => a.id === Number(download[1]));
      if (!asset) return send(404, { message: "Not Found" });
      record.status = 200;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(asset.content);
    }
    if (!record.authorized) return send(401, { message: "Bad credentials" });

    const uploadsRoot = `/uploads${this.prefix}/releases/`;
    if (url.pathname.startsWith(uploadsRoot)) {
      const m = /^(\d+)\/assets$/u.exec(url.pathname.slice(uploadsRoot.length));
      const release = m && this.releases.find((r) => r.id === Number(m[1]));
      const name = url.searchParams.get("name");
      if (req.method !== "POST" || !release || !name) return send(404, { message: "Not Found" });
      record.assetName = name;
      if (release.assets.some((a) => a.name === name)) return send(422, { message: "already_exists" });
      const asset = this.addAsset(release, name, body);
      this.uploads.push({ releaseId: release.id, name, body, seq: record.seq });
      return send(201, this.assetJson(asset));
    }

    const root = `/api${this.prefix}/releases`;
    if (!url.pathname.startsWith(root)) return send(404, { message: "Not Found" });
    const rest = url.pathname.slice(root.length);
    if (rest === "" && req.method === "GET") return send(200, this.page(this.releases, url.searchParams).map((r) => this.releaseJson(r)));
    if (rest === "" && req.method === "POST") {
      const data = JSON.parse(body.toString("utf8") || "{}");
      record.json = data;
      const release = this.addRelease({ tag_name: data.tag_name, name: data.name ?? data.tag_name, draft: data.draft === true });
      return send(201, this.releaseJson(release));
    }
    let m = /^\/tags\/(.+)$/u.exec(rest);
    if (m && req.method === "GET") {
      const release = this.releases.find((r) => r.tag_name === decodeURIComponent(m[1]) && !r.draft);
      return release ? send(200, this.releaseJson(release)) : send(404, { message: "Not Found" });
    }
    m = /^\/assets\/(\d+)$/u.exec(rest);
    if (m) {
      const owner = this.releases.find((r) => r.assets.some((a) => a.id === Number(m[1])));
      const asset = owner?.assets.find((a) => a.id === Number(m[1]));
      if (!asset) return send(404, { message: "Not Found" });
      if (req.method === "DELETE") {
        owner.assets = owner.assets.filter((a) => a !== asset);
        return send(204);
      }
      if (req.method === "GET") {
        if (!record.accept.includes("application/octet-stream")) return send(200, this.assetJson(asset));
        record.status = 200;
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(asset.content);
      }
    }
    m = /^\/(\d+)(\/assets)?$/u.exec(rest);
    if (m) {
      const release = this.releases.find((r) => r.id === Number(m[1]));
      if (!release) return send(404, { message: "Not Found" });
      if (m[2] && req.method === "GET") return send(200, this.page(release.assets, url.searchParams).map((a) => this.assetJson(a)));
      if (!m[2] && req.method === "GET") return send(200, this.releaseJson(release));
      if (!m[2] && req.method === "DELETE") {
        this.releases = this.releases.filter((r) => r !== release);
        this.deleted.push(release.tag_name);
        return send(204);
      }
    }
    return send(404, { message: "Not Found" });
  }

  /** Requests that changed something. */
  mutations() {
    return this.requests.filter((r) => r.method !== "GET");
  }
}

/** Runs `bash <script>` with exactly `env`, without blocking the event loop. */
export function runScript(script, env, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // Anything that is not the fake server cannot be reached.
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} killed on a deadline; stdout=${stdout} stderr=${stderr}`));
    }, PROCESS_DEADLINE_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      // A script that does not exist is not a refusal: fail every test, not just the good-path ones.
      if (status === 127 && stderr.includes("No such file or directory")) reject(new Error(`script missing: ${stderr}`));
      else resolve({ status, stdout, stderr });
    });
  });
}
