import net from "node:net";

const bindAddress = process.env.LAN_BIND_IP ?? "192.168.1.10";
const targets = [
  { name: "convex-backend", listenPort: 3210, targetPort: 3210 },
  { name: "convex-site", listenPort: 3211, targetPort: 3211 },
  { name: "convex-dashboard", listenPort: 6791, targetPort: 6791 },
];

const servers = [];

for (const target of targets) {
  const server = net.createServer((client) => {
    const upstream = net.connect(target.targetPort, "127.0.0.1");

    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());

    client.pipe(upstream);
    upstream.pipe(client);
  });

  server.on("error", (error) => {
    console.error(`${target.name} ${bindAddress}:${target.listenPort} failed: ${error.message}`);
    process.exit(1);
  });

  server.listen(target.listenPort, bindAddress, () => {
    console.log(`${target.name}: ${bindAddress}:${target.listenPort} -> 127.0.0.1:${target.targetPort}`);
  });

  servers.push(server);
}

function closeServers(signal) {
  console.log(`received ${signal}; closing LAN forwarders`);
  let remaining = servers.length;
  const finish = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  for (const server of servers) server.close(finish);
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", () => closeServers("SIGTERM"));
process.on("SIGINT", () => closeServers("SIGINT"));
