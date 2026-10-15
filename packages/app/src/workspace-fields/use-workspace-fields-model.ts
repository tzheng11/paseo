import { useEffect, useState, useSyncExternalStore } from "react";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { WorkspaceFieldsModel, workspaceFieldsAvailability } from "./model";

const selectValues = (workspace: WorkspaceDescriptor) => workspace.fieldValues ?? {};
const emptyValues: Record<string, string> = {};
export function useWorkspaceFieldsModel(serverId: string, workspaceId: string) {
  const values = useWorkspaceFields(serverId, workspaceId, selectValues) ?? emptyValues;
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo ?? null);
  const connected = useHostRuntimeIsConnected(serverId);
  const availability = workspaceFieldsAvailability(info, connected);
  const [model] = useState(
    () =>
      new WorkspaceFieldsModel(async (input) => {
        const client = getHostRuntimeStore().getClient(serverId);
        if (!client) throw new Error("Host is disconnected. Reconnect and retry.");
        return client.setWorkspaceFieldValue({ ...input, workspaceId });
      }),
  );
  useEffect(() => {
    model.receive(values, availability);
  }, [model, values, availability]);
  const state = useSyncExternalStore(model.subscribe, model.snapshot, model.snapshot);
  return { model, state };
}
