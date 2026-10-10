import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  buildRelayWebSocketUrl,
  buildDaemonWebSocketUrl,
} from "@getpaseo/protocol/daemon-endpoints";
import { WebSocket } from "ws";
import { createOrganizerMcpServer } from "./server";

const target = process.env.PASEO_ORGANIZER_HOST?.trim();
if (!target)
  throw new Error(
    "Set PASEO_ORGANIZER_HOST to the organization host's pairing URL or explicit WebSocket endpoint. No implicit local master is selected.",
  );
const offer = target.startsWith("https://") ? parseConnectionOfferFromUrl(target) : null;
let url: string;
if (offer)
  url = buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint,
    serverId: offer.serverId,
    role: "client",
    useTls: offer.relay.useTls ?? true,
  });
else if (target.startsWith("ws://") || target.startsWith("wss://")) url = target;
else url = buildDaemonWebSocketUrl(target, { useTls: false });
const client = new DaemonClient({
  url,
  clientId: `organizer-mcp-${randomUUID()}`,
  clientType: "cli",
  appVersion: "0.11.2",
  connectTimeoutMs: 30_000,
  reconnect: { enabled: false },
  ...(offer ? { e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 } } : {}),
  ...(process.env.PASEO_PASSWORD ? { password: process.env.PASEO_PASSWORD } : {}),
  webSocketFactory: (endpoint, options) =>
    new WebSocket(endpoint, options?.protocols, {
      headers: options?.headers,
    }) as unknown as WebSocketLike,
});
await client.connect();
const server = createOrganizerMcpServer((method, input) =>
  client.invokePluginRpc("workspace-organizer", method, input),
);
const transport = new StdioServerTransport();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await client.close();
}
// MCP transports expose callback properties, not EventTarget listeners.
// oxlint-disable-next-line unicorn/prefer-add-event-listener
transport.onclose = () => {
  void close();
};
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
await server.connect(transport);
