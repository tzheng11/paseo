import type { DaemonClient } from "./daemon-client.js";

export interface PaseoFleetActions {
  getMainHost: DaemonClient["getMainHost"];
  setMainHost: DaemonClient["setMainHost"];
  applyMainHost: DaemonClient["applyMainHost"];
}

export function createFleetActions(client: DaemonClient): PaseoFleetActions {
  return {
    getMainHost: (requestId) => client.getMainHost(requestId),
    setMainHost: (input) => client.setMainHost(input),
    applyMainHost: (input) => client.applyMainHost(input),
  };
}
