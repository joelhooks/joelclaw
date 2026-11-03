import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";

// Origin allowlist in front of the local Convex backend on the tailnet path.
// Convex reflects any Origin in CORS, so without this any web page open in a
// tailnet browser could call public queries and mutations (sec-20261103-003).
// Requests with no Origin header (convex CLI, Node and bun clients) pass: they
// are not browsers and cannot be driven by a web page. Function-level auth in
// the Convex app is the real fix for non-browser callers.

export const parseRoutes = (value) =>
  value
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [listen, target] = pair.split(":").map(Number);
      if (!Number.isInteger(listen) || !Number.isInteger(target)) {
        throw new Error(`bad route '${pair}', expected listenPort:targetPort`);
      }
      return { listen, target };
    });

export const loadAllowedOrigins = (file) => {
  if (!file) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const origins = Array.isArray(parsed) ? parsed : parsed.allowedOrigins;
  if (!Array.isArray(origins) || !origins.every((o) => typeof o === "string")) {
    throw new Error(`${file} must hold a JSON array of origins or { "allowedOrigins": [...] }`);
  }
  return origins;
};

export const originAllowed = (origin, allowed) =>
  origin === undefined || (origin !== "null" && allowed.includes(origin));

// Every HTTP answer carries this header so health checks know they reached the
// proxy and not some other listener on the port.
export const PROXY_HEADER = "x-convex-origin-proxy";

const refuse = (log, kind, req) =>
  log(`refused ${kind} ${req.method} ${(req.url ?? "").split("?")[0]} origin=${req.headers.origin}`);

export const createProxy = ({ target, allowed, host = "127.0.0.1", log = console.error }) => {
  const server = http.createServer((req, res) => {
    if (!originAllowed(req.headers.origin, allowed)) {
      refuse(log, "http", req);
      res.writeHead(403, { "content-type": "text/plain", [PROXY_HEADER]: "1" }).end("Forbidden origin\n");
      return;
    }
    const upstream = http.request(
      { host, port: target, method: req.method, path: req.url, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, [...upstreamRes.rawHeaders, PROXY_HEADER, "1"]);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", [PROXY_HEADER]: "1" });
      res.end("Bad gateway\n");
    });
    req.pipe(upstream);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!originAllowed(req.headers.origin, allowed)) {
      refuse(log, "upgrade", req);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(target, host, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  return server;
};

const main = () => {
  const routes = parseRoutes(process.env.CONVEX_PROXY_ROUTES ?? "13210:3210,13211:3211");
  const allowed = loadAllowedOrigins(process.env.CONVEX_PROXY_ALLOWED_ORIGINS_FILE);
  const bind = process.env.CONVEX_PROXY_BIND ?? "127.0.0.1";
  for (const { listen, target } of routes) {
    const server = createProxy({ target, allowed });
    server.on("error", (error) => {
      console.error(`convex-origin-proxy ${bind}:${listen} failed: ${error.message}`);
      process.exit(1);
    });
    server.listen(listen, bind, () => {
      console.log(`convex-origin-proxy ${bind}:${listen} -> 127.0.0.1:${target}, ${allowed.length} allowed origin(s)`);
    });
  }
};

if (import.meta.url === `file://${process.argv[1]}`) main();
