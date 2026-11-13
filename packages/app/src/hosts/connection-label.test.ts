import { expect, it } from "vitest";
import { formatRoutedHostLabel } from "./connection-label";

it("names the intermediate host and follows its current label", () => {
  const origin = { serverId: "srv_origin", label: "Mac Studio" };
  expect(formatRoutedHostLabel(origin.serverId, [origin])).toBe("Via Mac Studio");
  expect(formatRoutedHostLabel(origin.serverId, [{ ...origin, label: "My Studio" }])).toBe(
    "Via My Studio",
  );
});

it.each([
  { hosts: [] },
  { hosts: [{ serverId: "srv_origin", label: "srv_origin" }] },
  { hosts: [{ serverId: "srv_origin", label: " " }] },
])("avoids exposing a raw origin id without a hostname", ({ hosts }) => {
  expect(formatRoutedHostLabel("srv_origin", hosts)).toBe("Via another host");
});
