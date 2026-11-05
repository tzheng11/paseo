import { expect, test } from "vitest";
import { isolatedWindowsEnvironment } from "./isolated-windows-environment.js";

test("preserves case-insensitive machine runtime variables and rebuilds machine-only module roots", () => {
  expect(
    isolatedWindowsEnvironment({
      SYSTEMROOT: "C:\\Windows",
      programfiles: "D:\\Programs",
      pathext: ".EXE;.CMD",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PSModulePath: "C:\\personal\\modules",
    }),
  ).toEqual({
    SystemRoot: "C:\\Windows",
    ProgramFiles: "D:\\Programs",
    PATHEXT: ".EXE;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PSModulePath:
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules;D:\\Programs\\WindowsPowerShell\\Modules",
  });
});

test("never inherits user stores, proxy aliases, provider credentials or user module paths", () => {
  expect(
    isolatedWindowsEnvironment({
      HOME: "personal-home",
      USERPROFILE: "personal-profile",
      APPDATA: "personal-data",
      SSH_AUTH_SOCK: "personal-agent",
      OPENAI_API_KEY: "fixture-secret",
      HTTPS_PROXY: "http://personal-proxy",
      PSModulePath: "personal-modules",
    }),
  ).toEqual({});
});

test("uses windir when SystemRoot is absent and does not fabricate missing directories", () => {
  expect(isolatedWindowsEnvironment({ windir: "D:\\Windows", ProgramFiles: "" })).toEqual({
    windir: "D:\\Windows",
    PSModulePath: "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
  });
});
