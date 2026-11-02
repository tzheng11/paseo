import { describe, expect, test } from "vitest";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptInput,
} from "./agent-sdk-types.js";
import {
  redactPermissionResponse,
  redactPromptInput,
  redactFirstAgentContext,
  SECRET_ANSWER_NOTICE,
} from "./secret-answer.js";

const syntheticKey = `sk-proj-${"Synthetic1_".repeat(8)}`;
const syntheticHexSuffix = "9a12e95ee4e4af8744e33a8ea8d50705";
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

describe("battery 6 runtime boundary matrix", () => {
  test.each([
    ['token = "Zq8!rT2$wX5&nB7k"', `token = "${SECRET_ANSWER_NOTICE}"`],
    ["token = Zq8!rT2$wX5&nB7k", `token = ${SECRET_ANSWER_NOTICE}`],
    ["pass: Zq8!rT2$wX5&nB7k", `pass: ${SECRET_ANSWER_NOTICE}`],
    // Consolidated item 8 restores bare pass to tier 2; the qualified label is tier 1.
    ["pass: 3 tests", "pass: 3 tests"],
    ["db pass: hunter2x", `db pass: ${SECRET_ANSWER_NOTICE}`],
  ])(
    "redacts labeled mixed-symbol values while preserving ordinary neighbours (%#)",
    (prompt, expected) => {
      expect(redactPromptInput(prompt)).toBe(expected);
      expect(redactPromptInput([{ type: "text", text: prompt }])).toEqual([
        { type: "text", text: expected },
      ]);
    },
  );

  test.each([
    { value: "wks_9a12e95ee4e4af87", withheld: false },
    { value: "prj_44e33a8ea8d50705", withheld: false },
    { value: "sk_live_" + syntheticHexSuffix, withheld: true },
    { value: "re_" + syntheticHexSuffix, withheld: true },
    { value: "hf_" + syntheticHexSuffix, withheld: true },
  ])(
    "distinguishes native identifiers from known credentials with hex suffixes (%#)",
    ({ value, withheld }) => {
      const expected = withheld ? SECRET_ANSWER_NOTICE : value;
      const neutral = {
        ...request,
        input: { questions: [{ header: "Choice", question: "Which one?" }] },
      };
      expect(
        redactPermissionResponse(
          { behavior: "allow", updatedInput: { answers: { Choice: value } } },
          neutral,
        ),
      ).toEqual({
        behavior: "allow",
        updatedInput: { answers: { Choice: expected } },
      });
      expect(redactPermissionResponse({ behavior: "deny", message: value })).toEqual({
        behavior: "deny",
        message: expected,
      });
      expect(redactPromptInput(`before ${value} after`)).toBe(`before ${expected} after`);
    },
  );

  test("preserves the accepted unlabeled 20-character chat token", () => {
    const value = "aB3dE7gH9kLmN2pQ5rT8";
    expect(redactPromptInput(value)).toBe(value);
    expect(redactPromptInput(`before ${value} after`)).toBe(`before ${value} after`);
    expect(redactPromptInput([{ type: "text", text: value }])).toEqual([
      { type: "text", text: value },
    ]);
  });
});

describe("permission answer sanitization", () => {
  test("offered string and object choices survive even when credential-shaped or requested", () => {
    const offered = ["aB3dE7gH9kLmN2pQ5rT8", "sk-proj-" + "Synthetic1".repeat(8)];
    for (const option of offered) {
      for (const options of [
        [option],
        [{ label: option }],
        [{ value: option, label: "Use existing" }],
      ]) {
        const question = {
          ...request,
          input: { questions: [{ header: "Password", question: "Enter your password", options }] },
        };
        for (const answers of [{ Password: option }, [option], { "Enter your password": option }]) {
          const response: AgentPermissionResponse = {
            behavior: "allow",
            updatedInput: { answers },
          };
          expect(redactPermissionResponse(response, question)).toEqual(response);
        }
      }
    }
  });

  test("standalone question choices are preserved in direct answer fields", () => {
    const option = "aB3dE7gH9kLmN2pQ5rT8";
    const question = { ...request, title: "Password", input: { options: [{ label: option }] } };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answer: option },
    };
    expect(redactPermissionResponse(response, question)).toEqual(response);
  });

  test("full question keys isolate ordinary neighbours from a password question", () => {
    const question = {
      ...request,
      input: {
        questions: [
          { question: "Which region?", header: "Region" },
          { question: "What is your password?", header: "Password" },
        ],
      },
    };
    expect(
      redactPermissionResponse(
        {
          behavior: "allow",
          updatedInput: {
            answers: {
              "Which region?": "us-east-1",
              "What is your password?": "hunter2x",
            },
          },
        },
        question,
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: {
        answers: {
          "Which region?": "us-east-1",
          "What is your password?": SECRET_ANSWER_NOTICE,
        },
      },
    });
  });

  test.each([
    "What is the root password?",
    "What is the sudo password?",
    "What is the admin password?",
    "What is the database password?",
    "Enter the VPN password",
    "Enter your password to continue",
    "Please enter the password for mac-mini-1",
    "Password for mac-mini-1?",
    "What is the password for this server?",
    "Enter your GitHub password",
    "What is the SSH passphrase?",
    "Admin password",
    "Sudo password:",
    "Provide the admin PIN to continue",
    "Paste your SSH token for mac-mini-1",
    "What is your PIN?",
    "I need your sudo password to continue.",
    "Please enter your macOS password so I can install Homebrew.",
    "Enter the password to unlock the keychain.",
    "Can I have the database password?",
    "The sudo password, please.",
    "What is the password to the keychain?",
    "Need the root password",
    "What is the accessToken?",
    "What is the clientSecret?",
    "What's the secretKey?",
    "What is the APIKEY?",
    "What is the GITHUB_CLIENT_SECRET?",
    "Set STRIPE_SECRET_KEY to what?",
    "Enter the pass code",
    "What's the MFA code?",
    "Paste the login credentials",
    "Paste the HMAC key",
    "Paste the service account key",
    "What's the root pwd?",
    "What's the db pass?",
    "What is the signing key?",
    "What's the backup code?",
    "Enter the 6-digit code from your authenticator app",
    "Paste the webhook secret",
    "Provide the secret",
  ])("withholds direct value requests through structured permission answers (%#)", (text) => {
    const question = { ...request, input: { questions: [{ header: "Account", question: text }] } };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Account: "xK9#mP2$vL5q" } },
    };
    expect(redactPermissionResponse(response, question)).toEqual({
      behavior: "allow",
      updatedInput: { answers: { Account: SECRET_ANSWER_NOTICE } },
    });
  });

  test.each([
    ["Should I reset the password?", "yes"],
    ["Should I reset the password?", "no"],
    ["Which password manager do you use?", ""],
  ])("keeps exact yes/no and empty replies to credential nouns (%#)", (text, value) => {
    const question = { ...request, input: { questions: [{ header: "Account", question: text }] } };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Account: value } },
    };
    expect(redactPermissionResponse(response, question)).toEqual(response);
  });

  test.each([
    "Enter token",
    "Paste your tokens",
    "Design tokens:",
    "GPIO pins for the LED strip?",
    "Pin for the dependency?",
    "What's the secret name?",
    "Which secret manager should I use?",
    "Paste the secret sauce recipe",
    "Secret scanning is enabled",
  ])("treats superseded bare terminology as ambiguous (%#)", (text) => {
    const question = { ...request, input: { questions: [{ header: "Choice", question: text }] } };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Choice: "hunter2x" } },
    };
    expect(redactPermissionResponse(response, question)).toEqual(response);
  });

  test("credential nouns isolate per-question answers while exact choices and yes/no remain deliverable", () => {
    const question: AgentPermissionRequest = {
      ...request,
      input: {
        questions: [
          {
            header: "Login",
            question: "The sudo password, please.",
            options: [{ label: "Use the existing secret store" }],
          },
          { header: "Region", question: "Which region?" },
          { header: "Confirm", question: "Should password validation be enabled?" },
        ],
      },
    };
    for (const secret of ["xK9#mP2$vL5q", "hunter2x", "q1W2e3R4t5Y6u7I8o9P0a/S+d1F2g3H4j5K6l7Z8"]) {
      expect(
        redactPermissionResponse(
          {
            behavior: "allow",
            updatedInput: { answers: { Login: secret, Region: "us-east-1", Confirm: "yes" } },
          },
          question,
        ),
      ).toEqual({
        behavior: "allow",
        updatedInput: {
          answers: { Login: SECRET_ANSWER_NOTICE, Region: "us-east-1", Confirm: "yes" },
        },
      });
    }
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: {
        answers: { Login: "Use the existing secret store", Region: "us-east-1", Confirm: "no" },
      },
    };
    expect(redactPermissionResponse(response, question)).toEqual(response);
  });

  test.each([
    "claude-sonnet-5-5",
    "release-2026-11-01",
    "iss-6389-secret-answers",
    "us-east-1-production",
    "postgres-16-alpine",
    "2026-11-01T21:40:48Z",
    "user2@example-company.com",
    "Button2Component.tsx",
  ])("preserves ordinary structured identifiers in answers and feedback (%#)", (value) => {
    const question = {
      ...request,
      input: { questions: [{ header: "Choice", question: "Which one?" }] },
    };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Choice: value } },
    };
    expect(redactPermissionResponse(response, question)).toEqual(response);
    expect(redactPermissionResponse({ behavior: "deny", message: value })).toEqual({
      behavior: "deny",
      message: value,
    });
  });
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
      selectedActionId: "projectAuthenticationConfigurationV2",
      updatedInput: {
        answers: { Color: "  Blue\n" },
        explanation: "Use option 2",
        questionIdentifier1234: "Blue",
        authenticationConfigurationVersion2: "Blue",
        questionIdentifier1234567890WithDetails: "Blue",
      },
      updatedPermissions: [{ type: "allow", scope: "session", enabled: true }],
    };
    expect(redactPermissionResponse(response, request)).toEqual(response);
  });

  test.each([
    { value: "q1W2e3R4t5Y6u7I8o9P0a/S+d1F2g3H4j5K6l7Z8", expected: SECRET_ANSWER_NOTICE },
    { value: "aB3dE7gH9kLmN2pQ5rT8", expected: SECRET_ANSWER_NOTICE },
    {
      value: "postgres://admin:s3cr3tPass99@db.internal:5432/app",
      expected: `postgres://admin:${SECRET_ANSWER_NOTICE}@db.internal:5432/app`,
    },
  ])(
    "withholds secret spans in neutral answers and permission feedback (%#)",
    ({ value, expected }) => {
      const neutral = {
        ...request,
        input: { questions: [{ header: "Choice", question: "Which one?" }] },
      };
      expect(
        redactPermissionResponse(
          { behavior: "allow", updatedInput: { answers: { Choice: value } } },
          neutral,
        ),
      ).toEqual({ behavior: "allow", updatedInput: { answers: { Choice: expected } } });
      expect(redactPermissionResponse({ behavior: "deny", message: value })).toEqual({
        behavior: "deny",
        message: expected,
      });
      expect(
        redactPermissionResponse({ behavior: "allow", updatedPermissions: [{ value }] }),
      ).toEqual({ behavior: "allow", updatedPermissions: [{ value: SECRET_ANSWER_NOTICE }] });
    },
  );

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
        questions: [{ header: "Password", question: "Which region should we use?" }],
      },
    };
    const response: AgentPermissionResponse = {
      behavior: "allow",
      updatedInput: { answers: { Password: "us-east-1" } },
    };
    expect(redactPermissionResponse(response, discussion)).toEqual(response);
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

describe("first prompt naming context", () => {
  test("sanitizes a copied naming seed while retaining ordinary bytes", () => {
    const context = { prompt: "Deploy with password=Xy7kL9mQ2vR4tZ1", attachments: undefined };
    expect(redactFirstAgentContext(context)).toEqual({
      ...context,
      prompt: `Deploy with password=${SECRET_ANSWER_NOTICE}`,
    });
    expect(context.prompt).toContain("Xy7kL9mQ2vR4tZ1");
    expect(redactFirstAgentContext({ prompt: "Deploy ordinary source" })).toEqual({
      prompt: "Deploy ordinary source",
    });
  });
});

describe("chat and steering answer sanitization", () => {
  test.each([
    [
      "prefix postgres://u:Ab3Cd4Ef5%20Gh6Ij7@host/db suffix",
      `prefix postgres://u:${SECRET_ANSWER_NOTICE}@host/db suffix`,
    ],
    ["prefix password=abc123%22xyz789 suffix", `prefix password=${SECRET_ANSWER_NOTICE} suffix`],
    ["prefix --token=Ab3Cd4Ef5%20Gh6Ij7 suffix", `prefix --token=${SECRET_ANSWER_NOTICE} suffix`],
    ["Cookie: session=abc123%3Bxyz789\nnext", `Cookie: session=${SECRET_ANSWER_NOTICE}\nnext`],
  ])("removes encoded value tails through the runtime prompt boundary (%#)", (prompt, expected) => {
    expect(redactPromptInput(prompt)).toBe(expected);
  });

  test("redacts secret spans and single-token replies to the latest real credential request", () => {
    const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(redactPromptInput(`export AWS_SECRET_ACCESS_KEY=${aws}\nnext line stays`)).toBe(
      `export AWS_SECRET_ACCESS_KEY=${SECRET_ANSWER_NOTICE}\nnext line stays`,
    );
    expect(redactPromptInput(syntheticKey)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactPromptInput(`Keep this prefix ${syntheticKey} and this suffix.`)).toBe(
      `Keep this prefix ${SECRET_ANSWER_NOTICE} and this suffix.`,
    );
    expect(redactPromptInput("x", "Enter your password:")).toBe(SECRET_ANSWER_NOTICE);
    expect(redactPromptInput("x", "Enter token")).toBe("x");
    expect(redactPromptInput("x", "Provide the secret")).toBe(SECRET_ANSWER_NOTICE);
    expect(redactPromptInput("Use the existing configuration", "Enter your password:")).toBe(
      "Use the existing configuration",
    );
    expect(redactPromptInput([{ type: "text", text: syntheticKey }])).toEqual([
      { type: "text", text: SECRET_ANSWER_NOTICE },
    ]);
  });

  test("preserves every ordinary fragment when a secret crosses provider text blocks", () => {
    expect(
      redactPromptInput([
        { type: "text", text: `  before\n${syntheticKey.slice(0, 5)}` },
        { type: "image", data: "synthetic-image", mimeType: "image/png" },
        { type: "text", text: syntheticKey.slice(5, 25) },
        { type: "text", text: `${syntheticKey.slice(25)}\n after  ` },
      ]),
    ).toEqual([
      { type: "text", text: `  before\n${SECRET_ANSWER_NOTICE}` },
      { type: "image", data: "synthetic-image", mimeType: "image/png" },
      { type: "text", text: "" },
      { type: "text", text: "\n after  " },
    ]);
  });

  test("withholds secrets in text attachment metadata and review comments", () => {
    const redacted = redactPromptInput([
      {
        type: "text",
        mimeType: "text/plain",
        text: "ordinary attachment",
        title: `Title before ${syntheticKey} title after`,
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
            body: `Review before ${syntheticKey} review after`,
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
    expect(redacted).toMatchObject([
      {
        type: "text",
        mimeType: "text/plain",
        text: "ordinary attachment",
        title: `Title before ${SECRET_ANSWER_NOTICE} title after`,
      },
      {
        type: "review",
        comments: [{ body: `Review before ${SECRET_ANSWER_NOTICE} review after` }],
      },
    ]);
  });

  test("preserves ordinary text, image data and attachment metadata", () => {
    const prompt = [
      { type: "text" as const, text: "  Use option 2\n" },
      { type: "image" as const, data: "synthetic-image", mimeType: "image/png" },
      { type: "text" as const, mimeType: "text/plain" as const, text: "safe", title: "Notes" },
    ];
    expect(redactPromptInput(prompt)).toEqual(prompt);
  });

  test.each([
    "Should password validation be enabled?",
    "Which token budget should we use?",
    "Should we enter token validation mode?",
    "Enter the token budget",
    "I updated the API key validation code.",
    "Enter your password. Then explain how you will test.",
    "The password is managed in the secret store. What should we test?",
  ])(
    "preserves exact yes replies regardless of the latest credential noun context: %s",
    (context) => {
      expect(redactPromptInput("yes", context)).toBe("yes");
      expect(redactPromptInput([{ type: "text", text: "yes" }], context)).toEqual([
        { type: "text", text: "yes" },
      ]);
    },
  );

  test.each([
    "I fixed the password reset bug in auth.ts and added three tests. All 42 pass. Should I continue with the settings page?",
    "Done. The API key is now read from process.env in config.ts…",
    "Should I rotate the API key?",
  ])("keeps chat replies after credential statements and yes/no questions: %s", (context) => {
    for (const value of [
      "ok",
      "continue",
      "lgtm",
      "go",
      "2",
      "thanks!",
      "continue with the settings page",
    ]) {
      expect(redactPromptInput(value, context)).toBe(value);
    }
  });

  test("preserves long ordinary prompts and redacts late spans without a length cutoff", () => {
    const prefix = `  ${"ordinary words\n".repeat(6_000)}`;
    const suffix = `\n${"more ordinary text\n".repeat(6_000)}  `;
    const ordinary = prefix + suffix;
    expect(ordinary.length).toBeGreaterThan(65_536);
    expect(redactPromptInput(ordinary)).toBe(ordinary);
    expect(redactPromptInput(`${prefix}${syntheticKey}${suffix}`)).toBe(
      `${prefix}${SECRET_ANSWER_NOTICE}${suffix}`,
    );
    expect(redactPromptInput(ordinary, "Enter your password:")).toBe(ordinary);
  });

  test("preserves large prompt arrays and attachments while redacting their secret spans", () => {
    const prompt: AgentPromptInput = Array.from({ length: 5_001 }, (_, index) => ({
      type: "text",
      text: `ordinary block ${index}\n`,
    }));
    prompt.push({
      type: "text",
      mimeType: "text/plain",
      title: "Notes",
      text: `${"ordinary attachment\n".repeat(5_000)}${syntheticKey}\nattachment suffix`,
    });
    const redacted = redactPromptInput(prompt);
    expect(Array.isArray(redacted)).toBe(true);
    if (!Array.isArray(redacted)) throw new Error("Expected prompt blocks");
    expect(redacted).toHaveLength(prompt.length);
    expect(redacted.slice(0, 5_001)).toEqual(prompt.slice(0, 5_001));
    expect(redacted.at(-1)).toEqual({
      ...prompt.at(-1),
      text: `${"ordinary attachment\n".repeat(5_000)}${SECRET_ANSWER_NOTICE}\nattachment suffix`,
    });
  });

  test("maps encoded split secrets to the original blocks and retains existing notice text", () => {
    const encoded = [...syntheticKey]
      .map((character) => `%${character.charCodeAt(0).toString(16)}`)
      .join("");
    const prefix = `😀 ${SECRET_ANSWER_NOTICE}\nordinary prefix `;
    const prompt: AgentPromptInput = [
      { type: "text", mimeType: "text/plain", title: "Notes", text: prefix + encoded.slice(0, 14) },
      { type: "text", text: encoded.slice(14) + " ordinary suffix" },
    ];
    expect(redactPromptInput(prompt)).toEqual([
      { type: "text", mimeType: "text/plain", title: "Notes", text: prefix + SECRET_ANSWER_NOTICE },
      { type: "text", text: " ordinary suffix" },
    ]);
  });

  test("keeps multi-block ordinary prose when a credential request would withhold a single token", () => {
    const prompt: AgentPromptInput = [
      { type: "text", text: "Use " },
      { type: "text", text: "the existing config" },
    ];
    expect(redactPromptInput(prompt, "Enter your password:")).toEqual(prompt);
    expect(redactPromptInput([{ type: "text", text: "x" }], "Enter your password:")).toEqual([
      { type: "text", text: SECRET_ANSWER_NOTICE },
    ]);
  });
});

test("withholds unsupported prompt shapes rather than throwing before admission", () => {
  const invalid = {
    text: syntheticKey,
  } as unknown as import("./agent-sdk-types.js").AgentPromptInput;
  expect(redactPromptInput(invalid)).toBe(SECRET_ANSWER_NOTICE);
});
