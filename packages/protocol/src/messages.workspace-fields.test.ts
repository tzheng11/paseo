import { expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WorkspaceDescriptorPayloadSchema,
} from "./messages.js";

const oldHost = { status: "server_info", serverId: "old-host", version: "0.11.2" };
const oldWorkspace = {
  id: "A",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/repo",
  workspaceDirectory: "/repo",
  projectKind: "directory",
  workspaceKind: "directory",
  name: "A",
  status: "done",
  activityAt: null,
};

test("v0.11.2 omitted-feature and no-values descriptors remain parseable", () => {
  expect(ServerInfoStatusPayloadSchema.parse(oldHost).features?.workspaceFields).toBeUndefined();
  expect(WorkspaceDescriptorPayloadSchema.parse(oldWorkspace).fieldValues).toBeUndefined();
  const legacyInputSchema = WorkspaceDescriptorPayloadSchema.in.omit({ fieldValues: true });
  expect(
    legacyInputSchema.parse({
      ...oldWorkspace,
      fieldValues: { notionIssueUrl: "future addition" },
    }),
  ).not.toHaveProperty("fieldValues");
});

test("new correlated request/response and additive discovery retain literal values", () => {
  const request = {
    type: "workspace.field.value.set.request",
    workspaceId: "A",
    fieldKey: "notionIssueUrl",
    value: "<b>literal</b>\n☃",
    expectedValue: "",
    requestId: "fields-123",
  };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  const response = {
    type: "workspace.field.value.set.response",
    payload: {
      requestId: request.requestId,
      workspaceId: "A",
      accepted: true,
      value: request.value,
      error: null,
      errorCode: null,
    },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  expect(
    WorkspaceDescriptorPayloadSchema.parse({
      ...oldWorkspace,
      fieldValues: { notionIssueUrl: request.value, futureKey: "kept" },
    }).fieldValues,
  ).toEqual({ notionIssueUrl: request.value, futureKey: "kept" });
  expect(
    ServerInfoStatusPayloadSchema.parse({
      ...oldHost,
      features: { workspaceFields: true },
      workspaceFieldCatalogVersion: 1,
    }),
  ).toMatchObject({ features: { workspaceFields: true }, workspaceFieldCatalogVersion: 1 });
});
