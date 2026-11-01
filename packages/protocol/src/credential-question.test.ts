import { describe, expect, test } from "vitest";
import { endsWithCredentialRequest, requestsCredential } from "./secret-answer.js";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const credentialQuestions = [
  "I need your sudo password to continue.",
  "Please enter your macOS password so I can install Homebrew.",
  "Enter the password to unlock the keychain.",
  "Can I have the database password?",
  "The sudo password, please.",
  "What is the password to the keychain?",
  "Need the root password",
  "What is your password?",
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
  "Could you give me the staging DB password?",
  "Type the keychain password",
  "Provide your Apple ID password",
  "What is the password for user deploy?",
  "Paste the API key for Resend",
  "Enter the 1Password master password",
  "Router admin password?",
  "What passcode should I use for the Mac?",
  "Enter the VPN passcode",
  "PIN",
  "What is the admin PIN?",
  "Enter the customer API key for this host",
  "Give me the PIN",
  "Type your passcode to continue",
  "Provide the admin PIN to continue",
  "What is your PIN?",
  "Paste your API key",
  "Provide your passphrase",
  "API key (optional)",
  "Your password:",
  "Mac login password?",
  "Your password please",
  "API key optional:",
  "Login password needed",
  "Which API key format do you use? Enter your password",
  "Provide both API keys",
  "Enter your passwords",
  "passwd",
  "Your pin",
  "Pin code",
  "pin number",
  "Please provide the 2FA code so I can sign in",
  "The OTP is needed for login",
  "one-time code",
  "Verification code, please",
  "Recovery code",
  "The API key is required",
  "Please provide the secret key",
  "access key",
  "access token",
  "auth token",
  "bearer token",
  "refresh token",
  "client secret",
  "private key passphrase",
  "Private key",
  "API token",
  "Authentication token",
  "Session token",
  "Paste your SSH token for mac-mini-1",
  "Secret token",
  "What is a password?",
  "Which password manager do you use?",
  "Should password validation be enabled?",
  "Enter your password. Then explain how you will test.",
];
const ambiguousQuestions = [
  "Enter token",
  "Paste your tokens",
  "Provide the secret",
  "Design token for the primary color?",
  "Design tokens:",
  "GPIO pins for the LED strip?",
  "Pin for the dependency?",
  "Which key should we use?",
  "Schedule a one-time task",
  "Which token budget should we use?",
  "Pin the dependency to version 3.11",
  "Which keystone should we choose?",
];
const syntheticAnswers = [
  { kind: "12-character symbol value", value: "xK9#mP2$vL5q" },
  { kind: "8-character word-and-digit value", value: "hunter2x" },
  { kind: "40-character base64-like value", value: "q1W2e3R4t5Y6u7I8o9P0a/S+d1F2g3H4j5K6l7Z8" },
];
const matrix = credentialQuestions.flatMap((question) =>
  syntheticAnswers.map((answer) => ({ question, kind: answer.kind, value: answer.value })),
);

describe("credential noun question policy", () => {
  test.each(credentialQuestions)("recognizes the noun without request syntax: %s", (question) => {
    expect(requestsCredential(question)).toBe(true);
    expect(endsWithCredentialRequest(question)).toBe(true);
  });

  test.each(ambiguousQuestions)("keeps bare or unrelated terminology ambiguous: %s", (question) => {
    expect(requestsCredential(question)).toBe(false);
    expect(endsWithCredentialRequest(question)).toBe(false);
  });

  test.each(matrix)("withholds $kind for $question", ({ question, value }) => {
    expect(redactSecretAnswer(value, question)).toBe(SECRET_ANSWER_NOTICE);
    expect(redactSecretPrompt(value, question)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each(["", "yes", "no", "YES", "No"])(
    "preserves the exact yes/no or empty exception (%#)",
    (value) => {
      for (const question of credentialQuestions) {
        expect(redactSecretAnswer(value, question)).toBe(value);
        expect(redactSecretPrompt(value, question)).toBe(value);
      }
    },
  );

  test("does not turn the exact yes/no exception into a phrase or substring bypass", () => {
    for (const value of ["yes, go ahead", "not yet", "yes12345", "no_secret_here"]) {
      expect(redactSecretAnswer(value, "Enter your password")).toBe(SECRET_ANSWER_NOTICE);
    }
  });

  test("does not treat bare terminology as context evidence for a short unshaped answer", () => {
    for (const question of ambiguousQuestions) {
      expect(redactSecretAnswer("hunter2x", question)).toBe("hunter2x");
      expect(redactSecretPrompt("hunter2x", question)).toBe("hunter2x");
    }
  });
});
