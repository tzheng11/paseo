import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { MainHostProvenance } from "@getpaseo/protocol/fleet/main-host";
import { MainHostRefusal, type MainHostStore } from "../../fleet/main-host-store.js";

export class FleetSession {
  constructor(
    private readonly store: MainHostStore | undefined,
    private readonly provenance: MainHostProvenance,
    private readonly emit: (message: SessionOutboundMessage) => void,
    private readonly supported: () => boolean,
  ) {}

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "fleet.main_host.get.request":
      case "fleet.main_host.set.request":
      case "fleet.main_host.apply.request":
        return this.handle(message);
      default:
        return undefined;
    }
  }

  private async handle(
    message: Extract<
      SessionInboundMessage,
      {
        type:
          | "fleet.main_host.get.request"
          | "fleet.main_host.set.request"
          | "fleet.main_host.apply.request";
      }
    >,
  ): Promise<void> {
    try {
      if (!this.store || !this.supported()) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId: message.requestId,
            requestType: message.type,
            code: "main_host_update_required",
            error:
              "Update this client and host to use Main host. The previous setting is unchanged.",
          },
        });
        return;
      }
      switch (message.type) {
        case "fleet.main_host.get.request":
          this.emit({
            type: "fleet.main_host.get.response",
            payload: {
              requestId: message.requestId,
              state: this.store.snapshot(),
              allocator: this.store.allocator(),
            },
          });
          return;
        case "fleet.main_host.set.request": {
          const { type: _type, ...input } = message;
          const state = await this.store.set(input, this.provenance);
          this.emit({
            type: "fleet.main_host.set.response",
            payload: {
              requestId: message.requestId,
              state,
              allocator: this.store.allocator(),
            },
          });
          return;
        }
        case "fleet.main_host.apply.request": {
          const { type: _type, ...input } = message;
          const state = await this.store.apply(input, this.provenance);
          this.emit({
            type: "fleet.main_host.apply.response",
            payload: {
              requestId: message.requestId,
              state,
              allocator: this.store.allocator(),
            },
          });
        }
      }
    } catch (error) {
      if (!(error instanceof MainHostRefusal)) throw error;
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          code: error.code,
          error: error.message,
          mainHost: error.current,
        },
      });
    }
  }
}
