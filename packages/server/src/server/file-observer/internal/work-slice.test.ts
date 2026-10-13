import { expect, test } from "vitest";
import { observationWork } from "./work-slice.js";

test("concurrent observations share one yield and cannot renew separate budgets", async () => {
  const first = observationWork.pause(true);
  expect(first).toBeInstanceOf(Promise);
  for (let i = 0; i < 92; i++) expect(observationWork.pause()).toBe(first);
  await first;
  let bounded: Promise<void> | undefined;
  for (let i = 0; i < 256; i++) bounded ??= observationWork.pause();
  expect(bounded).toBeInstanceOf(Promise);
  expect(bounded).not.toBe(first);
  await bounded;
});
