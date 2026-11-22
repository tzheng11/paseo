import {
  applyBackingReclaim,
  previewBackingReclaim,
  getBackingReclaimStatus,
  verifyBackingReclaimHook,
  type BackingReclaimDependencies,
} from "../workspace-backing-reclaim.js";
import {
  getWorkspaceRetirementStatus,
  verifyWorkspaceRetirementBinding,
} from "../workspace-retirement.js";
import type { Logger } from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { WorkspaceLayoutService } from "../workspace-layout-service.js";
import { WorkspaceLayoutRefusal } from "../workspace-layout-store.js";
import { DaemonRpcError } from "@getpaseo/client/internal/daemon-client";
import type { SessionDelivery } from "./owned-subscriptions/index.js";

type LayoutRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "workspace.layout.inspect.request"
      | "workspace.layout.initialize.request"
      | "workspace.layout.commit.request"
      | "workspace.layout.receipt.request"
      | "workspace.retirement.status.request"
      | "workspace.retirement.verify.request";
  }
>;

type ReclaimRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "workspace.reclaim.preview.request"
      | "workspace.reclaim.apply.request"
      | "workspace.reclaim.get_status.request"
      | "workspace.reclaim.verify.request";
  }
>;

export class WorkspaceLayoutSession {
  constructor(
    private readonly service: WorkspaceLayoutService | undefined,
    private readonly delivery: SessionDelivery,
    private readonly emit: (message: SessionOutboundMessage) => void,
    private readonly logger: Logger,
    private readonly reclaimDependencies?: () => BackingReclaimDependencies,
  ) {}

  dispatch(message: SessionInboundMessage): Promise<void> | undefined {
    switch (message.type) {
      case "workspace.layout.inspect.request":
      case "workspace.layout.initialize.request":
      case "workspace.layout.commit.request":
      case "workspace.layout.receipt.request":
      case "workspace.retirement.status.request":
      case "workspace.retirement.verify.request":
        return this.handle(message);
      case "workspace.reclaim.preview.request":
      case "workspace.reclaim.apply.request":
      case "workspace.reclaim.get_status.request":
      case "workspace.reclaim.verify.request":
        return this.handleReclaim(message);
      default:
        return undefined;
    }
  }

  private async handleReclaim(message: ReclaimRequest): Promise<void> {
    try {
      if (!this.service || !this.reclaimDependencies)
        throw new WorkspaceLayoutRefusal("reclaim_inventory_unavailable");
      const deps = this.reclaimDependencies();
      if (message.type === "workspace.reclaim.preview.request")
        this.emit({
          type: "workspace.reclaim.preview.response",
          payload: {
            requestId: message.requestId,
            preview: await previewBackingReclaim(deps, message),
          },
        });
      else if (message.type === "workspace.reclaim.apply.request")
        this.emit({
          type: "workspace.reclaim.apply.response",
          payload: {
            requestId: message.requestId,
            operation: await applyBackingReclaim(deps, message),
          },
        });
      else if (message.type === "workspace.reclaim.get_status.request")
        this.emit({
          type: "workspace.reclaim.get_status.response",
          payload: {
            requestId: message.requestId,
            operation: await getBackingReclaimStatus(deps, message.operationId),
          },
        });
      else
        this.emit({
          type: "workspace.reclaim.verify.response",
          payload: {
            requestId: message.requestId,
            ...(await verifyBackingReclaimHook(this.service.options.home, message)),
          },
        });
    } catch (error) {
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          code:
            error instanceof WorkspaceLayoutRefusal ? error.code : "reclaim_evidence_unverified",
          error: "Backing reclaim evidence could not be verified.",
        },
      });
    }
  }
  private async handle(message: LayoutRequest): Promise<void> {
    try {
      if (!this.service) throw new WorkspaceLayoutRefusal("canonical_layout_not_configured");
      if (message.type === "workspace.retirement.status.request") {
        this.emit({
          type: "workspace.retirement.status.response",
          payload: {
            requestId: message.requestId,
            operation: await getWorkspaceRetirementStatus(this.service, message.operationId),
          },
        });
      } else if (message.type === "workspace.retirement.verify.request") {
        this.emit({
          type: "workspace.retirement.verify.response",
          payload: {
            requestId: message.requestId,
            ...(await verifyWorkspaceRetirementBinding(this.service.options.home, message)),
          },
        });
      } else if (message.type === "workspace.layout.receipt.request") {
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
      } else if (message.observe) {
        await this.observe(message);
      } else {
        const snapshot = await this.service.inspect();
        this.requireRetirementReader(message.retirementVersion, snapshot.retirementVersion);
        this.emit({
          type: "workspace.layout.inspect.response",
          payload: {
            requestId: message.requestId,
            snapshot,
          },
        });
      }
    } catch (error) {
      let code: string | undefined;
      if (error instanceof WorkspaceLayoutRefusal) code = error.code;
      else if (error instanceof DaemonRpcError && error.requestType === message.type)
        code = error.code;
      if (!code)
        this.logger.error(
          { err: error, operation: message.type },
          "Workspace layout request failed",
        );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          code: code ?? "layout_failed",
          error: "Workspace layout could not be verified. Refresh the authority before writing.",
        },
      });
    }
  }

  private requireRetirementReader(version: 1 | undefined, required: 1 | undefined): void {
    if (required === 1 && version !== 1)
      throw new WorkspaceLayoutRefusal("retirement_reader_required");
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
      this.requireRetirementReader(
        message.type === "workspace.layout.inspect.request" ? message.retirementVersion : undefined,
        snapshot.retirementVersion,
      );
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
