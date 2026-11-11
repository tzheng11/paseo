import { describe, expect, it } from "vitest";

const {
  FDROID_ABI_VERSION_CODE_SUFFIXES,
  getFdroidVersionCodes,
  getNativeReleaseVersion,
  getNativeConfigVersion,
} = require("./native-release-version");

describe("native release version", () => {
  it("encodes pinned Impower Expo config without changing the package version or publishing a native release", () => {
    const distribution = {
      name: "impower",
      upstreamVersion: "0.15.0",
      upstreamCommit: "a".repeat(40),
    };
    expect(getNativeConfigVersion("0.15.0-impower", distribution)).toEqual(
      getNativeReleaseVersion("0.15.0"),
    );
    expect(() => getNativeReleaseVersion("0.15.0-impower")).toThrow("unsupported version");
    expect(getNativeConfigVersion("0.15.0-beta.2", distribution)).toEqual(
      getNativeReleaseVersion("0.15.0-beta.2"),
    );
  });

  it("refuses absent or mismatched distribution bindings and never strips an arbitrary suffix", () => {
    const binding = { name: "impower", upstreamVersion: "0.15.0", upstreamCommit: "a".repeat(40) };
    for (const distribution of [
      undefined,
      { ...binding, name: "other" },
      { ...binding, upstreamVersion: "0.14.0" },
      { ...binding, upstreamCommit: "not-a-commit" },
    ])
      expect(() => getNativeConfigVersion("0.15.0-impower", distribution)).toThrow(
        "matching pinned upstream",
      );
    expect(() => getNativeConfigVersion("0.15.0-other", binding)).toThrow("unsupported version");
  });
  it("reserves the final iOS build slot for a stable release", () => {
    expect(getNativeReleaseVersion("0.2.6")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006999",
    });
  });

  it("gives each beta a unique iOS build slot under the stable app version", () => {
    expect(getNativeReleaseVersion("0.2.6-beta.2")).toEqual({
      appVersion: "0.2.6",
      androidVersionCode: 2006,
      iosBuildNumber: "2006002",
    });
  });

  it("rejects beta numbers that consume the stable iOS build slot", () => {
    expect(() => getNativeReleaseVersion("0.2.6-beta.999")).toThrow(
      "iOS beta number must be between 1 and 998",
    );
  });

  it("derives one F-Droid version code per published ABI", () => {
    expect(FDROID_ABI_VERSION_CODE_SUFFIXES).toEqual({
      "armeabi-v7a": 1,
      "arm64-v8a": 2,
      x86: 3,
      x86_64: 4,
    });
    expect(getFdroidVersionCodes("0.5.0")).toEqual([
      { abi: "armeabi-v7a", versionCode: 50001 },
      { abi: "arm64-v8a", versionCode: 50002 },
      { abi: "x86", versionCode: 50003 },
      { abi: "x86_64", versionCode: 50004 },
    ]);
  });
});
