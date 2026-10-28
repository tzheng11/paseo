import http from "node:http";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

interface ProxyAwareHttpAgent extends http.Agent {
  options?: { proxyEnv?: NodeJS.ProcessEnv };
}

/** Own a fixed parser while retaining Node's explicitly enabled environment proxy policy. */
export function createHttpDispatcher(): Agent | EnvHttpProxyAgent {
  // Node 22.23 and 24.20 store their resolved proxy option here. Read that state
  // rather than reimplement CLI/NODE_OPTIONS precedence or enable proxies implicitly.
  const proxyEnv = (http.globalAgent as ProxyAwareHttpAgent).options?.proxyEnv;
  return proxyEnv
    ? new EnvHttpProxyAgent({
        // Node's embedded Undici 6/7 defaults to CONNECT even for plain HTTP.
        proxyTunnel: true,
        httpProxy: proxyEnv.http_proxy ?? proxyEnv.HTTP_PROXY ?? "",
        httpsProxy: proxyEnv.https_proxy ?? proxyEnv.HTTPS_PROXY ?? "",
      })
    : new Agent();
}

let configured = false;

/** Select the fixed HTTP parser once for this process, including captured native fetch calls. */
export function configureHttpTransport(): void {
  if (configured) return;
  // Importing Undici alone preserves a warmed Node 24 dispatcher with the paused-FIN crash.
  // Its public setter bridges both dispatcher APIs without replacing native web constructors.
  setGlobalDispatcher(createHttpDispatcher());
  // This default lives for the process, not one embedded daemon. Leave the previous
  // dispatcher alive: an embedding host may still have requests in flight on it.
  configured = true;
}
