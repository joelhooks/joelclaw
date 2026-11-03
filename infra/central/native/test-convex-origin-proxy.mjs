import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { createProxy, originAllowed, parseRoutes, PROXY_HEADER } from "./convex-origin-proxy.mjs";

// node --test infra/central/native/test-convex-origin-proxy.mjs
const ALLOWED = "https://paper.example";
let backend;
let proxy;
let proxyPort;
const seen = [];
const refusals = [];

const sockets = new Set();
const listen = (server) => {
  server.on("connection", (socket) => sockets.add(socket));
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
};

before(async () => {
  backend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json", "x-backend": "convex" });
      res.end(JSON.stringify({ status: "success", path: req.url, body }));
    });
  });
  backend.on("upgrade", (req, socket, head) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (d) => socket.write(d));
  });
  const backendPort = await listen(backend);
  proxy = createProxy({ target: backendPort, allowed: [ALLOWED], log: (line) => refusals.push(line) });
  proxyPort = await listen(proxy);
});

after(() => {
  for (const socket of sockets) socket.destroy();
  proxy.close();
  backend.close();
});

const post = (path, origin) =>
  new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", ...(origin === undefined ? {} : { origin }) };
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "POST", path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ path: "notes:remove", args: {} }));
  });

const upgrade = (origin, early = "") =>
  new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      const lines = [
        "GET /api/1.0/sync HTTP/1.1",
        `Host: 127.0.0.1:${proxyPort}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...(origin === undefined ? [] : [`Origin: ${origin}`]),
      ];
      socket.write(`${lines.join("\r\n")}\r\n\r\n${early}`);
    });
    let data = "";
    socket.on("data", (d) => {
      data += d;
      if (data.startsWith("HTTP/1.1 101") && data.includes("\r\n\r\n") && !data.includes("ping") && !early) socket.write("ping");
      if (data.includes("ping") || data.startsWith("HTTP/1.1 403")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });

test("a client with no Origin (CLI, Node, bun) reaches Convex unchanged", async () => {
  const r = await post("/api/mutation", undefined);
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-backend"], "convex");
  assert.equal(r.headers[PROXY_HEADER], "1");
  assert.equal(JSON.parse(r.body).path, "/api/mutation");
  assert.match(seen.at(-1).body, /notes:remove/);
});

test("the allowlisted browser Origin reaches Convex", async () => {
  assert.equal((await post("/api/query", ALLOWED)).status, 200);
});

test("a foreign Origin gets 403 on queries and mutations and never reaches Convex", async () => {
  const before = seen.length;
  for (const path of ["/api/mutation", "/api/query", "/api/action"]) {
    assert.equal((await post(path, "https://evil.example")).status, 403);
  }
  assert.equal((await post("/api/mutation", "null")).status, 403);
  assert.equal((await post("/api/mutation", `${ALLOWED}.evil.example`)).status, 403);
  assert.equal((await post("/api/mutation", "https://evil.example")).headers[PROXY_HEADER], "1");
  assert.equal(seen.length, before);
  assert.ok(refusals.some((line) => line.includes("origin=https://evil.example")));
});

test("WebSocket sync: no Origin and the allowlisted Origin upgrade; a foreign Origin gets 403", async () => {
  assert.match(await upgrade(undefined), /^HTTP\/1\.1 101[\s\S]*ping$/);
  assert.match(await upgrade(ALLOWED), /^HTTP\/1\.1 101[\s\S]*ping$/);
  assert.match(await upgrade("https://evil.example"), /^HTTP\/1\.1 403/);
});

test("bytes sent with the upgrade request are forwarded too", async () => {
  assert.match(await upgrade(undefined, "ping"), /^HTTP\/1\.1 101[\s\S]*ping$/);
});

test("origin and route parsing", () => {
  assert.equal(originAllowed(undefined, []), true);
  assert.equal(originAllowed("null", ["null"]), false);
  assert.equal(originAllowed("https://a.example", ["https://a.example"]), true);
  assert.deepEqual(parseRoutes("4210:3210, 4211:3211"), [{ listen: 4210, target: 3210 }, { listen: 4211, target: 3211 }]);
  assert.throws(() => parseRoutes("4210"), /bad route/);
});
