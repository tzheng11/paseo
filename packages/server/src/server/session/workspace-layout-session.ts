import type { Logger } from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { WorkspaceLayoutService } from "../workspace-layout-service.js";
import { WorkspaceLayoutRefusal } from "../workspace-layout-store.js";
import type { SessionDelivery } from "./owned-subscriptions/index.js";

type LayoutRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "workspace.layout.inspect.request"
      | "workspace.layout.initialize.request"
      | "workspace.layout.commit.request"
      | "workspace.layout.receipt.request";
  }
>;

export class WorkspaceLayoutSession {
  constructor(
    private readonly service: WorkspaceLayoutService | undefined,
    private readonly delivery: SessionDelivery,
    private readonly emit: (message: SessionOutboundMessage) => void,
    private readonly logger: Logger,
  ) {}

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "workspace.layout.inspect.request":
      case "workspace.layout.initialize.request":
      case "workspace.layout.commit.request":
      case "workspace.layout.receipt.request":
        return this.handle(message);
      default:
        return undefined;
    }
  }

  private async handle(message: LayoutRequest): Promise<void> {
    try {
      if (!this.service) throw new WorkspaceLayoutRefusal("canonical_layout_not_configured");
      if (message.type === "workspace.layout.receipt.request") {
        this.emit({
          type: "workspace.layout.receipt.response",
          payload: {
            requestId: message.requestId,
            receipt: await this.service.findReceipt(message.mutationRequestId),
          },
        });
      } else if (message.type === "workspace.layout.initialize.request") {
        const snapshot = await this.service.initialize(message.identity);
        this.emit({
          type: "workspace.layout.initialize.response",
          payload: { requestId: message.requestId, snapshot },
        });
      } else if (message.type === "workspace.layout.commit.request") {
        const { type: _type, ...input } = message;
        const receipt = await this.service.commit(input);
        this.emit({
          type: "workspace.layout.commit.response",
          payload: { requestId: message.requestId, receipt },
        });
      } else if (message.observe) await this.observe(message);
      else
        this.emit({
          type: "workspace.layout.inspect.response",
          payload: {
            requestId: message.requestId,
            snapshot: await this.service.inspect(),
          },
        });
    } catch (error) {
      if (!(error instanceof WorkspaceLayoutRefusal))
        this.logger.error(
          { err: error, operation: message.type },
          "Workspace layout request failed",
        );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          code: error instanceof WorkspaceLayoutRefusal ? error.code : "layout_failed",
          error: "Workspace layout could not be verified. Refresh the authority before writing.",
        },
      });
    }
  }

  private async observe(message: LayoutRequest): Promise<void> {
    const service = this.service!;
    let stop: (() => void) | undefined;
    const owner = this.delivery.begin("workspace-layout", undefined, () => stop?.());
    const publish = () => {
      const snapshot = service.cached().snapshot;
      if (snapshot)
        owner.emit({
          type: "workspace.layout.changed",
          payload: { subscriptionId: owner.responseId, snapshot },
        });
    };
    try {
      stop = service.subscribe(publish);
      const snapshot = await service.inspect();
      this.emit({
        type: "workspace.layout.inspect.response",
        payload: {
          requestId: message.requestId,
          subscriptionId: owner.responseId,
          snapshot,
        },
      });
    } catch (error) {
      await owner.release();
      throw error;
    }
  }
}
