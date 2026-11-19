import type { z } from "zod";

/** The caller, not a parser, establishes absence and captures stable private bytes. */
export type CapturedJson =
  | { state: "present"; bytes: string | Uint8Array }
  | { state: "absent" }
  | { state: "unreadable" };
export type ParsedCapture<T> = { state: "present"; value: T } | { state: "absent" };

/** Static codes only: config values, JSON text and schema errors may contain secrets. */
export class CapturedJsonRefusal extends Error {
  constructor(readonly code: string) {
    super(`Captured JSON refused: ${code}`);
    this.name = "CapturedJsonRefusal";
  }
}

/** Validate with the real schema, returning its INPUT unchanged, including omissions.
 * Normalization of a supplied field is a refusal; schema-added defaults are not returned.
 */
export function parseCapturedJson<S extends z.ZodType>(
  capture: CapturedJson,
  schema: S,
): ParsedCapture<z.input<S>> {
  if (capture.state === "absent") return { state: "absent" };
  if (capture.state !== "present") throw new CapturedJsonRefusal("json_unreadable");
  let text: string;
  let value: unknown;
  try {
    text =
      typeof capture.bytes === "string"
        ? capture.bytes
        : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(capture.bytes);
    value = JSON.parse(text);
  } catch {
    throw new CapturedJsonRefusal("json_invalid");
  }
  // JSON.parse accepts repeated object keys, silently discarding earlier values.
  // It has already checked grammar; this scan only checks decoded key uniqueness.
  const objects: ({ keys: Set<string>; keyExpected: boolean } | null)[] = [];
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    if (token === "{") objects.push({ keys: new Set(), keyExpected: true });
    else if (token === "[") objects.push(null);
    else if (token === "}" || token === "]") objects.pop();
    else {
      const object = objects.at(-1);
      if (token === ",") {
        if (object) object.keyExpected = true;
      } else if (object?.keyExpected) {
        const key = JSON.parse(token) as string;
        if (object.keys.has(key)) throw new CapturedJsonRefusal("json_duplicate_key");
        object.keys.add(key);
        object.keyExpected = false;
      }
    }
  }
  return { state: "present", value: validateCapturedValue(value, schema) };
}

export function validateCapturedValue<S extends z.ZodType>(value: unknown, schema: S): z.input<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CapturedJsonRefusal("json_schema_invalid");
  assertPreserved(value, result.data);
  return value as z.input<S>;
}

function assertPreserved(input: unknown, parsed: unknown): void {
  if (Array.isArray(input)) {
    if (!Array.isArray(parsed) || input.length !== parsed.length)
      throw new CapturedJsonRefusal("json_field_changed");
    input.forEach((value, index) => assertPreserved(value, parsed[index]));
  } else if (input !== null && typeof input === "object") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new CapturedJsonRefusal("json_field_changed");
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(parsed, key)) throw new CapturedJsonRefusal("json_field_changed");
      assertPreserved(value, (parsed as Record<string, unknown>)[key]);
    }
  } else if (!Object.is(input, parsed) || (typeof input === "number" && !Number.isFinite(input))) {
    throw new CapturedJsonRefusal("json_field_changed");
  }
}
