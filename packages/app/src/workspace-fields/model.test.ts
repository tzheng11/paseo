import { expect, test } from "vitest";
import { WorkspaceFieldsModel, workspaceFieldsAvailability } from "./model";
import { WorkspaceFieldError } from "@getpaseo/protocol/workspace-fields";

test("v0.11.2 omitted-feature, version-2 and denied actors never dispatch a save", async () => {
  expect(
    workspaceFieldsAvailability({ features: {}, permissions: ["workspace.manage"] }, true),
  ).toBe("update");
  expect(
    workspaceFieldsAvailability(
      {
        features: { workspaceFields: true },
        workspaceFieldCatalogVersion: 2,
        permissions: ["workspace.manage"],
      },
      true,
    ),
  ).toBe("update");
  for (const permissions of [["workspace.read"], ["hub.execute"]]) {
    expect(
      workspaceFieldsAvailability(
        { features: { workspaceFields: true }, workspaceFieldCatalogVersion: 1, permissions },
        true,
      ),
    ).toBe("readOnly");
  }
  let calls = 0;
  const model = new WorkspaceFieldsModel(async () => {
    calls++;
    return { value: "bad" };
  });
  model.receive({ notionProjectUrl: "" }, "update");
  model.edit("notionProjectUrl");
  await model.save();
  expect(calls).toBe(0);
});

test("pending prevents duplicate saves and background snapshots preserve the draft", async () => {
  let calls = 0;
  let resolve!: (value: { value: string }) => void;
  const model = new WorkspaceFieldsModel(() => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  });
  model.receive({ notionProjectUrl: "old" }, "ready");
  model.edit("notionProjectUrl");
  model.change("draft");
  const save = model.save();
  expect(model.snapshot().editor?.status).toBe("saving");
  await model.save();
  model.change("ignored");
  model.cancel();
  model.receive({ notionProjectUrl: "background" }, "ready");
  expect(model.snapshot().editor?.draft).toBe("draft");
  expect(calls).toBe(1);
  resolve({ value: "draft" });
  await save;
  expect(model.snapshot().editor).toBeNull();
  expect(model.snapshot().values.notionProjectUrl).toBe("draft");
});

test("failure and lost acknowledgement keep draft/expected value for safe retry; conflict reopens latest", async () => {
  const inputs: unknown[] = [];
  let fail = true;
  const model = new WorkspaceFieldsModel(async (input) => {
    inputs.push(input);
    if (fail) throw new Error("Acknowledgement lost");
    return { value: input.value };
  });
  model.receive({ notionIssueUrl: "old" }, "ready");
  model.edit("notionIssueUrl");
  model.change("new");
  await model.save();
  expect(model.snapshot().editor).toMatchObject({
    draft: "new",
    expectedValue: "old",
    status: "error",
  });
  model.receive({ notionIssueUrl: "new" }, "ready");
  fail = false;
  await model.save();
  expect(inputs[0]).toEqual(inputs[1]);
  const conflicting = new WorkspaceFieldsModel(async () => {
    throw new WorkspaceFieldError("conflict", "Changed elsewhere");
  });
  conflicting.receive({ notionProjectUrl: "old" }, "ready");
  conflicting.edit("notionProjectUrl");
  conflicting.change("draft");
  conflicting.receive({ notionProjectUrl: "latest" }, "ready");
  await conflicting.save();
  expect(conflicting.snapshot().editor).toMatchObject({ draft: "draft", conflict: true });
  conflicting.cancel();
  conflicting.edit("notionProjectUrl");
  expect(conflicting.snapshot().editor?.draft).toBe("latest");
});

test("disconnect retains draft with visible error and reconnect permits retry; Cancel discards", async () => {
  const model = new WorkspaceFieldsModel(async (input) => ({ value: input.value }));
  model.receive({ notionProjectUrl: "saved" }, "ready");
  model.edit("notionProjectUrl");
  model.change("draft");
  model.receive({ notionProjectUrl: "saved" }, "offline");
  await model.save();
  expect(model.snapshot().editor).toMatchObject({
    draft: "draft",
    status: "error",
    error: "offline",
  });
  model.receive({ notionProjectUrl: "saved" }, "ready");
  await model.save();
  model.edit("notionProjectUrl");
  model.change("discard");
  model.cancel();
  expect(model.snapshot().values.notionProjectUrl).toBe("draft");
});
