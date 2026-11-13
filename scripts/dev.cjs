"use strict";
// Development-only preview. Production always starts server.js directly.
process.env.NODE_ENV = "development";
const index = process.argv.indexOf("--port");
process.env.PORT =
  index >= 0 ? process.argv[index + 1] : process.env.PORT || "4173";
process.env.PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT}`;
process.env.PUBLIC_BACKEND_ORIGIN = process.env.PUBLIC_BASE_URL;
process.env.PUBLIC_API_BASE = process.env.PUBLIC_BASE_URL;
process.env.CANONICAL_ORIGIN = process.env.PUBLIC_BASE_URL;
const { app } = require("../server");
const { configureHttpServer } = require("../server/core/requestSecurity");
const server = require("node:http").createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/__viewport") {
    const width = Math.min(
      1440,
      Math.max(320, Number(url.searchParams.get("width")) || 375),
    );
    const route = String(url.searchParams.get("page") || "/");
    const target =
      /^\/(?:|magaza|sepet|hesabim|destek|admin\/|kategori\/[a-z0-9-]+|urun\/[a-z0-9-]+)$/.test(
        route,
      )
        ? route
        : "/";
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    });
    return res.end(
      `<!doctype html><html lang="tr"><title>Responsive preview</title><style>body{background:#e9ecf2;font:14px system-ui;margin:0}header{text-align:center;padding:14px}header a{margin:0 12px;color:#24394b}iframe{display:block;margin:auto;width:${width}px;height:850px;border:1px solid #ccd1dc;background:#fff;box-shadow:0 10px 35px #2235}</style><header>Test genişliği: ${width}px · <a href="/__viewport?width=320">320</a><a href="/__viewport?width=375">375</a><a href="/__viewport?width=390">390</a><a href="/__viewport?width=768">768</a><a href="/__viewport?width=1280">1280</a></header><iframe title="Zentra Store responsive preview" src="${target}"></iframe></html>`,
    );
  }
  const setHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (String(name).toLowerCase() === "content-security-policy")
      value = String(value).replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      );
    if (String(name).toLowerCase() === "x-frame-options") value = "SAMEORIGIN";
    return setHeader.call(this, name, value);
  };
  app(req, res);
});
configureHttpServer(server);
server.listen(Number(process.env.PORT), "0.0.0.0");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
