import { describe, expect, test } from "vitest";
import { endsWithCredentialRequest, requestsCredential } from "./secret-answer.js";
import { redactSecretAnswer, redactSecretPrompt, SECRET_ANSWER_NOTICE } from "./secret-answer.js";

const expandedCredentialQuestions = [
  "What is the accessToken?",
  "What is the clientSecret?",
  "What's the secretKey?",
  "What is the APIKEY?",
  "What is the GITHUB_APIKEY?",
  "Paste APP_APIKEY",
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
];
const credentialIdentifierForms = [
  ["accessToken", "access_token", "access-token", "ACCESS_TOKEN"],
  ["clientSecret", "client_secret", "client-secret", "CLIENT_SECRET"],
  ["secretKey", "secret_key", "secret-key", "SECRET_KEY"],
  ["apiKey", "api_key", "api-key", "APIKEY"],
  ["githubApiKey", "github_api_key", "github-api-key", "GITHUB_APIKEY"],
  ["appApiKey", "app_api_key", "app-api-key", "APP_APIKEY"],
  ["githubClientSecret", "github_client_secret", "github-client-secret", "GITHUB_CLIENT_SECRET"],
  ["stripeSecretKey", "stripe_secret_key", "stripe-secret-key", "STRIPE_SECRET_KEY"],
  ["rootPwd", "root_pwd", "root-pwd", "ROOT_PWD"],
  ["dbPass", "db_pass", "db-pass", "DB_PASS"],
  ["passCode", "pass_code", "pass-code", "PASS_CODE"],
  ["mfaCode", "mfa_code", "mfa-code", "MFA_CODE"],
  ["totpCode", "totp_code", "totp-code", "TOTP_CODE"],
  ["backupCode", "backup_code", "backup-code", "BACKUP_CODE"],
  ["authenticatorCode", "authenticator_code", "authenticator-code", "AUTHENTICATOR_CODE"],
  ["hmacKey", "hmac_key", "hmac-key", "HMAC_KEY"],
  ["serviceAccountKey", "service_account_key", "service-account-key", "SERVICE_ACCOUNT_KEY"],
  ["signingKey", "signing_key", "signing-key", "SIGNING_KEY"],
  ["encryptionKey", "encryption_key", "encryption-key", "ENCRYPTION_KEY"],
  ["sshKey", "ssh_key", "ssh-key", "SSH_KEY"],
  ["webhookSecret", "webhook_secret", "webhook-secret", "WEBHOOK_SECRET"],
  ["sharedSecret", "shared_secret", "shared-secret", "SHARED_SECRET"],
  ["appSecret", "app_secret", "app-secret", "APP_SECRET"],
  ["jwtSecret", "jwt_secret", "jwt-secret", "JWT_SECRET"],
  ["apiSecret", "api_secret", "api-secret", "API_SECRET"],
];
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
  "Provide the secret",
  "Secret:",
  "Enter the code from your authenticator app",
  "What is a password?",
  "Which password manager do you use?",
  "Should password validation be enabled?",
  "Enter your password. Then explain how you will test.",
  ...expandedCredentialQuestions,
  ...credentialIdentifierForms.flatMap((forms) =>
    forms.map((identifier) => `What is the ${identifier}?`),
  ),
];
const nonRequestCredentialContexts = [
  "Login password needed",
  "The OTP is needed for login",
  "The API key is required",
  "What is a password?",
  "Which password manager do you use?",
  "Should password validation be enabled?",
  "Set STRIPE_SECRET_KEY to what?",
  "I fixed the password reset bug in auth.ts and added three tests. All 42 pass. Should I continue with the settings page?",
  "Done. The API key is now read from process.env in config.ts…",
  "Should I rotate the API key?",
];
const nonRequestCredentialContextSet = new Set(nonRequestCredentialContexts);
const realCredentialRequests = credentialQuestions.filter(
  (question) => !nonRequestCredentialContextSet.has(question),
);
const ambiguousQuestions = [
  "Enter token",
  "Paste your tokens",
  "Design token for the primary color?",
  "Design tokens:",
  "GPIO pins for the LED strip?",
  "Pin for the dependency?",
  "Which key should we use?",
  "Schedule a one-time task",
  "Which token budget should we use?",
  "Pin the dependency to version 3.11",
  "Which keystone should we choose?",
  "The secret store is configured",
  "Which secret manager should I use?",
  "Provide the secret sauce recipe",
  "What's the secret name?",
  "Secret scanning is enabled",
  "secretStore",
  "secret_name",
  "secret-scanning",
  "All tests pass",
];
const syntheticAnswers = [
  { kind: "12-character symbol value", value: "xK9#mP2$vL5q" },
  { kind: "8-character word-and-digit value", value: "hunter2x" },
  { kind: "40-character base64-like value", value: "q1W2e3R4t5Y6u7I8o9P0a/S+d1F2g3H4j5K6l7Z8" },
];
const matrix = credentialQuestions.flatMap((question) =>
  syntheticAnswers.map((answer) => ({ question, kind: answer.kind, value: answer.value })),
);
const chatMatrix = realCredentialRequests.flatMap((question) =>
  syntheticAnswers.map((answer) => ({ question, kind: answer.kind, value: answer.value })),
);

describe("credential noun question policy", () => {
  test.each(credentialQuestions)("recognizes the noun without request syntax: %s", (question) => {
    expect(requestsCredential(question)).toBe(true);
  });

  test.each(realCredentialRequests)("recognizes an actual chat value request: %s", (question) => {
    expect(endsWithCredentialRequest(question)).toBe(true);
  });

  test.each(nonRequestCredentialContexts)(
    "keeps chat statements and yes/no questions: %s",
    (context) => {
      expect(endsWithCredentialRequest(context)).toBe(false);
      for (const value of [
        "ok",
        "continue",
        "lgtm",
        "go",
        "2",
        "thanks!",
        "continue with the settings page",
      ]) {
        expect(redactSecretPrompt(value, context)).toBe(value);
      }
    },
  );

  test.each(ambiguousQuestions)("keeps bare or unrelated terminology ambiguous: %s", (question) => {
    expect(requestsCredential(question)).toBe(false);
    expect(endsWithCredentialRequest(question)).toBe(false);
  });

  test.each(matrix)("withholds structured $kind for $question", ({ question, value }) => {
    expect(redactSecretAnswer(value, question)).toBe(SECRET_ANSWER_NOTICE);
  });

  test.each(chatMatrix)("withholds chat $kind after $question", ({ question, value }) => {
    expect(redactSecretPrompt(value, question)).toBe(SECRET_ANSWER_NOTICE);
  });

  test("withholds a structured synthetic multiword answer after an actual credential request", () => {
    const value = "synthetic amber birch phrase";
    expect(redactSecretAnswer(value, "Please provide your password.")).toBe(SECRET_ANSWER_NOTICE);
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
