import { describe, expect, test } from "vitest";
import { join, resolve } from "node:path";
import { createDarwinEventPathFilter, resolveDarwinWatchBackend } from "./darwin-watch-backend.js";

describe("Darwin watcher backend", () => {
  test("keeps Parcel as the unset default and accepts only explicit Darwin modes", () => {
    expect(resolveDarwinWatchBackend({}, "darwin")).toBe("parcel");
    expect(resolveDarwinWatchBackend({}, "linux")).toBe("parcel");
    for (const backend of ["parcel", "node"]) {
      expect(resolveDarwinWatchBackend({ PASEO_DARWIN_WATCH_BACKEND: backend }, "darwin")).toBe(
        backend,
      );
      expect(() =>
        resolveDarwinWatchBackend({ PASEO_DARWIN_WATCH_BACKEND: backend }, "linux"),
      ).toThrow(/only supported on Darwin/);
    }
    for (const backend of ["", "auto", "Node", "node "]) {
      expect(() =>
        resolveDarwinWatchBackend({ PASEO_DARWIN_WATCH_BACKEND: backend }, "darwin"),
      ).toThrow(/PASEO_DARWIN_WATCH_BACKEND/);
    }
  });

  test("filters physical ignored ancestors before accepting lexical event paths", () => {
    const root = resolve("/var/fixture");
    const physicalRoot = resolve("/private/var/fixture");
    const filter = createDarwinEventPathFilter({
      root,
      physicalRoot,
      ignored: [join(root, "node_modules"), join(root, "[build]")],
    });
    expect(filter(join("node_modules", "a", "b.txt"))).toBeUndefined();
    expect(filter(Buffer.from(join("[build]", "x.txt")))).toBeUndefined();
    expect(filter(join("node_modules-visible", "a.txt"))).toBe(
      join("node_modules-visible", "a.txt"),
    );
    expect(filter(join(physicalRoot, "src", "x.txt"))).toBe(join("src", "x.txt"));
    expect(filter(join("..", "outside.txt"))).toBeUndefined();
    expect(filter(resolve("/unrelated/file.txt"))).toBeUndefined();
    expect(filter(null)).toBeNull();
    expect(filter("")).toBeNull();
  });

  test("a root exclusion suppresses pathless events while unrelated exclusions do not", () => {
    const root = resolve("/fixture");
    const options = { root, physicalRoot: root };
    expect(createDarwinEventPathFilter({ ...options, ignored: [root] })(null)).toBeUndefined();
    expect(
      createDarwinEventPathFilter({ ...options, ignored: [resolve("/elsewhere")] })("a.txt"),
    ).toBe("a.txt");
  });
});
