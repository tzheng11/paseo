import { expect, test } from "vitest";
import { WorkspaceFieldsModel, workspaceFieldsAvailability } from "./model";
import { WorkspaceFieldError } from "@getpaseo/protocol/workspace-fields";

test.each(["newer-second-client", "old"])(
  "a delayed acknowledgement preserves authoritative value %s",
  async (latest) => {
    let resolve!: (result: { value: string }) => void;
    const model = new WorkspaceFieldsModel(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    model.receive({ notionProjectUrl: "old" }, "ready");
    model.edit("notionProjectUrl");
    model.change("first-save");
    const saving = model.save();
    model.receive({ notionProjectUrl: "first-save" }, "ready");
    model.receive({ notionProjectUrl: latest }, "ready");
    resolve({ value: "first-save" });
    await saving;
    expect(model.snapshot().values.notionProjectUrl).toBe(latest);
    expect(model.snapshot().editor).toBeNull();
  },
);

test("a different-key snapshot still permits the successful save value to display", async () => {
  let resolve!: (result: { value: string }) => void;
  const model = new WorkspaceFieldsModel(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  model.receive({ notionProjectUrl: "old", notionIssueUrl: "issue" }, "ready");
  model.edit("notionProjectUrl");
  model.change("first-save");
  const saving = model.save();
  model.receive({ notionProjectUrl: "old", notionIssueUrl: "new issue" }, "ready");
  resolve({ value: "first-save" });
  await saving;
  expect(model.snapshot().values).toEqual({
    notionProjectUrl: "first-save",
    notionIssueUrl: "new issue",
  });
});

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
  expect(model.snapshot().values.notionProjectUrl).toBe("background");
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

test("unknown workspace data never becomes an editable empty value", () => {
  const info = {
    features: { workspaceFields: true },
    workspaceFieldCatalogVersion: 1,
    permissions: ["workspace.manage"],
  };
  expect(workspaceFieldsAvailability(info, true, false)).toBe("loading");
  const model = new WorkspaceFieldsModel(async () => ({ value: "saved" }));
  model.receive(null, "loading");
  expect(model.snapshot().hasValues).toBe(false);
  model.edit("notionProjectUrl");
  expect(model.snapshot().editor).toBeNull();
  model.receive({ notionProjectUrl: "saved" }, "ready");
  model.receive(null, "loading");
  expect(model.snapshot()).toMatchObject({
    hasValues: true,
    values: { notionProjectUrl: "saved" },
  });
  model.edit("notionProjectUrl");
  expect(model.snapshot().editor).toBeNull();
  model.receive({ notionProjectUrl: "newer" }, "ready");
  model.edit("notionProjectUrl");
  expect(model.snapshot().editor).toMatchObject({ expectedValue: "newer", draft: "newer" });
});

test("saved snapshots seed the first render and remain visible during reconnect", () => {
  const model = new WorkspaceFieldsModel(async (input) => ({ value: input.value }), {
    values: { notionProjectUrl: "saved URL", notionIssueUrl: "" },
    availability: "loading",
  });
  expect(model.snapshot()).toMatchObject({
    values: { notionProjectUrl: "saved URL", notionIssueUrl: "" },
    hasValues: true,
  });
  model.receive(null, "offline");
  expect(model.snapshot().values.notionProjectUrl).toBe("saved URL");
  model.receive({ notionProjectUrl: "new URL" }, "ready");
  model.edit("notionProjectUrl");
  expect(model.snapshot().editor?.expectedValue).toBe("new URL");
});
