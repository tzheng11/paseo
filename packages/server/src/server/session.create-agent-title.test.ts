import { describe, expect, test } from "vitest";

import { resolveCreateAgentTitles } from "./agent/create-agent-title.js";
import { SECRET_ANSWER_NOTICE } from "@getpaseo/protocol/secret-answer";

describe("resolveCreateAgentTitles", () => {
  test("redacts a synthetic secret before deriving or truncating first-prompt titles", () => {
    const secret = `sk-proj-${"Synthetic1_".repeat(8)}`;
    const resolved = resolveCreateAgentTitles({
      initialPrompt: `Deploy with ${secret} then verify.`,
    });
    expect(resolved.provisionalTitle).toBe(`Deploy with ${SECRET_ANSWER_NOTICE}`.slice(0, 60));
    expect(JSON.stringify(resolved)).not.toContain(secret);
    expect(JSON.stringify(resolved)).not.toContain(secret.slice(0, 20));
  });
  test("derives a provisional title from prompt when explicit title is absent", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: undefined,
      initialPrompt: "Implement auth retries with backoff\n\ninclude tests",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBe("Implement auth retries with backoff");
  });

  test("preserves explicit title and does not treat it as provisional", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "  Keep This Title  ",
      initialPrompt: "Ignored prompt title",
    });

    expect(resolved.explicitTitle).toBe("Keep This Title");
    expect(resolved.provisionalTitle).toBe("Keep This Title");
  });

  test("returns null values when prompt and title are empty", () => {
    const resolved = resolveCreateAgentTitles({
      configTitle: "   ",
      initialPrompt: "   ",
    });

    expect(resolved.explicitTitle).toBeNull();
    expect(resolved.provisionalTitle).toBeNull();
  });
});
