import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { redactSecretPrompt } from "./secret-answer.js";

interface SourceLine {
  path: string;
  line: number;
  text: string;
}

interface SourceLineSnapshot {
  count: number;
  sourceSha256: string;
  lines: SourceLine[];
}

const snapshot: SourceLineSnapshot = JSON.parse(
  readFileSync(new URL("../tests/secret-answer-source-lines.json", import.meta.url), "utf8"),
);

// Each source exception is reviewed by location and reason. This manifest is test-only;
// the runtime detector never reads source names or permits an asset-wide exemption.
const REVIEWED_K3_LOSSES: Record<string, string> = {
  "packages/app/src/i18n/resources/ar.ts:1797":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ar.ts:1839":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/en.ts:1822":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/en.ts:1863":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/es.ts:1844":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/es.ts:1886":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/fr.ts:1842":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/fr.ts:1884":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ja.ts:1814":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ja.ts:1855":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ko.ts:1807":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ko.ts:1847":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/pt-BR.ts:1829":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/pt-BR.ts:1871":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ru.ts:1827":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/ru.ts:1869":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/zh-CN.ts:1779":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/app/src/i18n/resources/zh-CN.ts:1819":
    "Quoted UI password literal is indistinguishable from a password answer (Manager ruling 10, item 20).",
  "packages/server/src/server/agent/providers/opencode/v2/runtime.ts:173":
    "A bare password variable under a password label is ambiguous with a literal password.",
  "packages/app/src/components/markdown/fence/mermaid/runtime/html.gen.ts:4":
    "Checked-in generated HTML contains opaque embedded scripts and assets; no runtime asset exemption is added.",
  "packages/app/src/terminal/webview/terminal-emulator-webview-html.ts:5":
    "Checked-in generated terminal HTML embeds wasm/base64 assets and opaque bundled identifiers; no wasm exemption is added.",
  "packages/app/src/utils/thinking-tone.native-pcm.ts:2":
    "Opaque checked-in PCM asset remains a named measurement loss; no audio-specific runtime exemption is added.",
  "packages/server/src/server/agent/agent-manager.ts:1202":
    "Password copula followed by a punctuated word satisfies the required six-character/two-class rule.",
  "packages/server/src/server/agent/providers/opencode/v2/runtime.ts:156":
    "A literal call argument containing a digit is outside the closed benign-argument list (base64url encoding name).",
  "packages/server/src/server/hub/relationship-controller.ts:314":
    "A literal call argument containing a digit is outside the closed benign-argument list (base64url encoding name).",
  "packages/server/src/server/local-credential.ts:13":
    "A literal call argument containing a digit is outside the closed benign-argument list (base64url encoding name).",
  "packages/server/src/server/relay-transport.ts:385":
    "Quoted template plus literal text is a literal credential value; only a whole substitution is exempt.",
  "packages/server/src/server/speech/providers/local/worker-process.ts:93":
    "Quoted template plus literal path text is a literal credential value; only a whole substitution is exempt.",
  "packages/protocol/src/secret-answer.ts:1062":
    "A conditional source expression has a quoted password literal followed by a colon, locally matching a credential field (items 1 and 20).",
};

// This functional corpus includes large checked-in generated assets. Its deadline
// is separate from the scanner throughput and scaling limits in the performance spec.
test("K3 keeps tracked source lines except the reviewed named losses", () => {
  expect(snapshot.lines.length).toBe(snapshot.count);
  expect(snapshot.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  const residue = snapshot.lines.flatMap(({ path, line, text }) =>
    redactSecretPrompt(text) === text ? [] : [`${path}:${line}`],
  );
  // Never print source text or detector output. Logs contain locations only.
  const unreviewed = residue.filter((location) => !REVIEWED_K3_LOSSES[location]);
  expect(unreviewed).toEqual([]);
  expect(residue.length).toBeLessThanOrEqual(30);
  for (const location of residue) expect(REVIEWED_K3_LOSSES[location].length).toBeGreaterThan(20);
}, 60_000);
