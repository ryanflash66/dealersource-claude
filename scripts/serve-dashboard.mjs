#!/usr/bin/env node
/**
 * Minimal static file server for dashboard/public.
 *
 *   node scripts/serve-dashboard.mjs          # http://localhost:4173/
 *   PORT=8080 node scripts/serve-dashboard.mjs
 *
 * SPA-friendly: unknown paths without a file extension serve index.html so
 * deep links work; paths with an extension that do not exist return 404
 * (so a missing config.js is a clean 404, not a page). No dependencies.
 * Does not open a browser.
 */

import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "public");
const port = Number.parseInt(process.env.PORT ?? "", 10) || 4173;
const host = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pmtiles": "application/octet-stream",
};

function fileStat(p) {
  try {
    const st = statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function serveFile(res, filePath, st, method) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": "no-cache",
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed");
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname);
  } catch {
    send(res, 400, "Bad Request");
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";

  const filePath = path.normalize(path.join(root, pathname));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    send(res, 403, "Forbidden");
    return;
  }

  const st = fileStat(filePath);
  if (st) {
    serveFile(res, filePath, st, req.method);
    return;
  }

  // SPA fallback: extensionless unknown paths get the app shell.
  if (!path.extname(pathname)) {
    const indexPath = path.join(root, "index.html");
    const ist = fileStat(indexPath);
    if (ist) {
      serveFile(res, indexPath, ist, req.method);
      return;
    }
  }
  send(res, 404, `Not Found: ${pathname}`);
});

server.on("error", (err) => {
  console.error(`[dashboard:serve] ${err.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[dashboard:serve] serving ${root}`);
  console.log(`[dashboard:serve] http://localhost:${port}/`);
});
