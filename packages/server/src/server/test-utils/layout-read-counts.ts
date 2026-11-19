import { vi } from "vitest";
import * as layoutProtocol from "@getpaseo/protocol/workspace-layout";

function graph(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.length === 3308;
  if ("entries" in value && Array.isArray(value.entries)) return value.entries.length === 3308;
  return "snapshot" in value && graph(value.snapshot);
}

/** Count graph copies regardless of whether the reader uses native, JSON or Map copying. */
export function measureLayoutReads() {
  const counts = { graphClones: 0, entryClones: 0, jsonCopies: 0, mapCopies: 0, derivations: 0 };
  let deriving = false;
  const resolve = layoutProtocol.resolveEffectiveWorkspaceLayout;
  const clone = globalThis.structuredClone;
  const stringify = JSON.stringify;
  const iterator = Map.prototype[Symbol.iterator];
  const entries = Map.prototype.entries;
  const values = Map.prototype.values;
  const keys = Map.prototype.keys;
  const forEach = Map.prototype.forEach;
  const enumeration = (map: Map<unknown, unknown>) => {
    if (!deriving && map.size === 3308) counts.mapCopies++;
  };
  const spies = [
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
      if (graph(value)) counts.graphClones++;
      else counts.entryClones++;
      return clone(value, options);
    }),
    vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      if (graph(args[0])) counts.jsonCopies++;
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
