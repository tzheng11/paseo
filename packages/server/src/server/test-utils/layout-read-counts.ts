import { vi } from "vitest";
import * as layoutProtocol from "@getpaseo/protocol/workspace-layout";

function graph(value: unknown, entryCount: number): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === entryCount;
  if ("entries" in value && Array.isArray(value.entries))
    return value.entries.length === entryCount;
  return "snapshot" in value && graph(value.snapshot, entryCount);
}

// Plain wrappers avoid recursively recording Vitest's own Array/WeakMap bookkeeping.
function replaceMethod(target: object, key: PropertyKey, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  if (!original) throw new Error("missing counted prototype method");
  Object.defineProperty(target, key, { ...original, value });
  return { mockRestore: () => Object.defineProperty(target, key, original) };
}

/** Count graph copies regardless of whether the reader uses native, JSON or Map copying. */
export function measureLayoutReads(entryCount = 3308) {
  const counts = {
    graphClones: 0,
    entryClones: 0,
    jsonCopies: 0,
    mapCopies: 0,
    derivations: 0,
    indexBuilds: 0,
    projectionBuilds: 0,
    arrayWalks: 0,
  };
  let deriving = false;
  const resolve = layoutProtocol.resolveEffectiveWorkspaceLayout;
  const clone = globalThis.structuredClone;
  const stringify = JSON.stringify;
  const iterator = Map.prototype[Symbol.iterator];
  const entries = Map.prototype.entries;
  const values = Map.prototype.values;
  const keys = Map.prototype.keys;
  const forEach = Map.prototype.forEach;
  const weakSet = WeakMap.prototype.set;
  const arrayMap = Array.prototype.map;
  const arrayIterator = Array.prototype[Symbol.iterator];
  const arrayForEach = Array.prototype.forEach;
  const enumeration = (map: Map<unknown, unknown>) => {
    if (!deriving && map.size === entryCount) counts.mapCopies++;
  };
  const spies = [
    replaceMethod(
      WeakMap.prototype,
      "set",
      function (this: WeakMap<object, unknown>, key: object, value: unknown) {
        if (graph(key, entryCount) && value && typeof value === "object") {
          if (
            "entries" in value &&
            value.entries instanceof Map &&
            value.entries.size === entryCount
          )
            counts.indexBuilds++;
          if ("read" in value && typeof value.read === "function") counts.projectionBuilds++;
        }
        return weakSet.call(this, key, value);
      },
    ),
    replaceMethod(Array.prototype, "map", function (this: unknown[], ...args: unknown[]) {
      if (!deriving && this.length === entryCount) counts.arrayWalks++;
      return Reflect.apply(arrayMap, this, args);
    }),
    replaceMethod(Array.prototype, Symbol.iterator, function (this: unknown[]) {
      if (!deriving && this.length === entryCount) counts.arrayWalks++;
      return arrayIterator.call(this);
    }),
    replaceMethod(Array.prototype, "forEach", function (this: unknown[], ...args: unknown[]) {
      if (!deriving && this.length === entryCount) counts.arrayWalks++;
      return Reflect.apply(arrayForEach, this, args);
    }),
    vi.spyOn(layoutProtocol, "resolveEffectiveWorkspaceLayout").mockImplementation((snapshot) => {
      counts.derivations++;
      deriving = true;
      try {
        return resolve(snapshot);
      } finally {
        deriving = false;
      }
    }),
    vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (graph(value, entryCount)) counts.graphClones++;
      else counts.entryClones++;
      return clone(value, options);
    }),
    vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      if (graph(args[0], entryCount)) counts.jsonCopies++;
      return Reflect.apply(stringify, JSON, args);
    }),
    vi
      .spyOn(Map.prototype, Symbol.iterator)
      .mockImplementation(function (this: Map<unknown, unknown>) {
        enumeration(this);
        return iterator.call(this);
      }),
    vi.spyOn(Map.prototype, "entries").mockImplementation(function (this: Map<unknown, unknown>) {
      enumeration(this);
      return entries.call(this);
    }),
    vi.spyOn(Map.prototype, "values").mockImplementation(function (this: Map<unknown, unknown>) {
      enumeration(this);
      return values.call(this);
    }),
    vi.spyOn(Map.prototype, "keys").mockImplementation(function (this: Map<unknown, unknown>) {
      enumeration(this);
      return keys.call(this);
    }),
    vi
      .spyOn(Map.prototype, "forEach")
      .mockImplementation(function (this: Map<unknown, unknown>, callback, thisArg) {
        enumeration(this);
        return forEach.call(this, callback, thisArg);
      }),
  ];
  return {
    counts,
    reset: () => {
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
    },
    restore: () => {
      for (const spy of spies.toReversed()) spy.mockRestore();
    },
  };
}
