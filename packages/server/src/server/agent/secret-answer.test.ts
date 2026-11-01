import { describe, expect, test } from "vitest";
import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";
import {
  redactPermissionResponse,
  redactPromptInput,
  SECRET_ANSWER_NOTICE,
} from "./secret-answer.js";

const syntheticKey = `sk-proj-${"Synthetic1_".repeat(8)}`;
const request: AgentPermissionRequest = {
  id: "permission-synthetic",
  provider: "codex",
  name: "request_user_input_async",
  kind: "question",
  title: "Questions",
  input: {
    questions: [
      { id: "password", header: "Account", question: "Enter your password" },
      { id: "color", header: "Color", question: "Which color should we use?" },
    ],
  },
};

describe("permission answer sanitization", () => {
  test("withholds only the answer to the sensitive question", () => {
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Account: "x", Color: "  Blue\n" } },
    };
    expect(redactPermissionResponse(response, request)).toEqual({
      behavior: "allow",
      updatedInput: { answers: { Account: SECRET_ANSWER_NOTICE, Color: "  Blue\n" } },
    });
    expect(response.updatedInput?.answers).toEqual({ Account: "x", Color: "  Blue\n" });
  });

  test("matches array indexes and fails closed for unmapped answers", () => {
    expect(
      redactPermissionResponse(
        { behavior: "allow", updatedInput: { answers: ["x", "Blue"] } },
        request,
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { answers: [SECRET_ANSWER_NOTICE, "Blue"] },
    });
    expect(
      redactPermissionResponse(
        { behavior: "allow", updatedInput: { answers: { unexpected: "x", Color: "Blue" } } },
        request,
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { answers: { unexpected: SECRET_ANSWER_NOTICE, Color: "Blue" } },
    });
  });

  test("withholds nested secret values, secret-named fields and secret-shaped object keys", () => {
    const response: AgentPermissionResponse = {
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: {
        answers: { Color: syntheticKey },
        nested: [{ password: "x", explanation: `Use ${syntheticKey}` }],
        [syntheticKey]: "synthetic key name",
      },
      updatedPermissions: [{ type: "allow", note: syntheticKey, token: "SYNTHETIC1234567890" }],
    };
    const redacted = redactPermissionResponse(response, request);
    expect(JSON.stringify(redacted)).not.toContain(syntheticKey);
    expect(redacted).toEqual({
      behavior: "allow",
      selectedActionId: "submit",
      updatedInput: {
        answers: { Color: SECRET_ANSWER_NOTICE },
        nested: [{ password: SECRET_ANSWER_NOTICE, explanation: SECRET_ANSWER_NOTICE }],
        "[redacted:secret-key-2]": SECRET_ANSWER_NOTICE,
      },
      updatedPermissions: [
        { type: "allow", note: SECRET_ANSWER_NOTICE, token: SECRET_ANSWER_NOTICE },
      ],
    });
  });

  test("withholds plan feedback and free-text denial messages", () => {
    expect(redactPermissionResponse({ behavior: "deny", message: syntheticKey })).toEqual({
      behavior: "deny",
      message: SECRET_ANSWER_NOTICE,
    });
    const passwordRequest = { ...request, input: undefined, title: "Provide the API key" };
    expect(redactPermissionResponse({ behavior: "deny", message: "x" }, passwordRequest)).toEqual({
      behavior: "deny",
      message: SECRET_ANSWER_NOTICE,
    });
  });

  test("withholds authorization metadata using the existing diagnostic policy", () => {
    expect(
      redactPermissionResponse({ behavior: "allow", updatedInput: { authorization: "x" } }),
    ).toEqual({ behavior: "allow", updatedInput: { authorization: SECRET_ANSWER_NOTICE } });
  });

  test("ordinary routing values and answers pass through unchanged", () => {
    const response: AgentPermissionResponse = {
      behavior: "allow",
      selectedActionId: "approve-once",
      updatedInput: { answers: { Color: "  Blue\n" }, explanation: "Use option 2" },
      updatedPermissions: [{ type: "allow", scope: "session", enabled: true }],
    };
    expect(redactPermissionResponse(response, request)).toEqual(response);
  });

  test("preserves ordinary token counters, failure codes and configuration flags in metadata", () => {
    const metadata = {
      tokenBudget: "1000",
      max_tokens: "4096",
      refresh_token: "expired",
      secretEnabled: "true",
      SECRET_ENABLED: true,
      access_token: "UnauthorizedException",
      token: "process.env.GITHUB_TOKEN",
    };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: metadata,
      updatedPermissions: [metadata],
    };
    expect(redactPermissionResponse(response)).toEqual(response);
    expect(
      redactPermissionResponse({ behavior: "allow", updatedInput: { password: "tiny" } }),
    ).toEqual({ behavior: "allow", updatedInput: { password: SECRET_ANSWER_NOTICE } });
  });

  test("a credential-named answer label does not override an ordinary substantive question", () => {
    const discussion: AgentPermissionRequest = {
      ...request,
      title: "Password",
      input: {
        questions: [{ header: "Password", question: "Should password validation be enabled?" }],
      },
    };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Password: "yes" } },
    };
    expect(redactPermissionResponse(response, discussion)).toEqual(response);
    expect(redactPromptInput("yes", [discussion])).toBe("yes");
  });

  test.each([
    { title: "Login", description: "Enter your password" },
    { question: "Account login", description: "Provide your API key" },
  ])("includes credential requests from question descriptions (%#)", (question) => {
    const described: AgentPermissionRequest = {
      ...request,
      input: { questions: [{ ...question, header: "Account" }] },
    };
    expect(
      redactPermissionResponse(
        { behavior: "allow", updatedInput: { answers: { Account: "x" } } },
        described,
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { answers: { Account: SECRET_ANSWER_NOTICE } },
    });
    expect(redactPromptInput("x", [described])).toBe(SECRET_ANSWER_NOTICE);
  });

  test("includes an explicit credential request in the overall card description", () => {
    const described: AgentPermissionRequest = {
      ...request,
      description: "Enter your password",
      input: { questions: [{ header: "Account", question: "Account login" }] },
    };
    expect(
      redactPermissionResponse(
        { behavior: "allow", updatedInput: { answers: { Account: "x" } } },
        described,
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { answers: { Account: SECRET_ANSWER_NOTICE } },
    });
  });

  test("fails closed on deep, wide and cyclic response content", () => {
    let deep: unknown = syntheticKey;
    for (let level = 0; level < 20; level += 1) deep = { nested: deep };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { deep, wide: Array.from({ length: 5_001 }, () => syntheticKey), cycle },
    };
    const serialized = JSON.stringify(redactPermissionResponse(response));
    expect(serialized).not.toContain(syntheticKey);
    expect(serialized).toContain(SECRET_ANSWER_NOTICE);
  });
});

describe("chat and steering answer sanitization", () => {
  test("withholds secret strings and arbitrary replies to secret questions", () => {
    expect(redactPromptInput(syntheticKey)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactPromptInput("x", [request])).toBe(SECRET_ANSWER_NOTICE);
    expect(redactPromptInput([{ type: "text", text: syntheticKey }])).toEqual([
      { type: "text", text: SECRET_ANSWER_NOTICE },
    ]);
  });

  test("withholds a secret split across provider text blocks", () => {
    expect(
      redactPromptInput([
        { type: "text", text: syntheticKey.slice(0, 5) },
        { type: "text", text: syntheticKey.slice(5) },
      ]),
    ).toEqual([
      { type: "text", text: SECRET_ANSWER_NOTICE },
      { type: "text", text: SECRET_ANSWER_NOTICE },
    ]);
  });

  test("withholds secrets in text attachment metadata and review comments", () => {
    const redacted = redactPromptInput([
      {
        type: "text",
        mimeType: "text/plain",
        text: "ordinary attachment",
        title: syntheticKey,
      },
      {
        type: "review",
        mimeType: "application/paseo-review",
        cwd: "/synthetic",
        mode: "uncommitted",
        comments: [
          {
            filePath: "synthetic.ts",
            side: "new",
            lineNumber: 1,
            body: syntheticKey,
            context: {
              hunkHeader: "@@ synthetic @@",
              targetLine: { oldLineNumber: null, newLineNumber: 1, type: "add", content: "safe" },
              lines: [],
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(redacted)).not.toContain(syntheticKey);
    expect(JSON.stringify(redacted)).toContain(SECRET_ANSWER_NOTICE);
  });

  test("preserves ordinary text, image data and attachment metadata", () => {
    const prompt = [
      { type: "text" as const, text: "  Use option 2\n" },
      { type: "image" as const, data: "synthetic-image", mimeType: "image/png" },
      { type: "text" as const, mimeType: "text/plain" as const, text: "safe", title: "Notes" },
    ];
    expect(redactPromptInput(prompt)).toEqual(prompt);
  });
});

test("withholds unsupported prompt shapes rather than throwing before admission", () => {
  const invalid = {
    text: syntheticKey,
  } as unknown as import("./agent-sdk-types.js").AgentPromptInput;
  expect(redactPromptInput(invalid)).toBe(SECRET_ANSWER_NOTICE);
});
