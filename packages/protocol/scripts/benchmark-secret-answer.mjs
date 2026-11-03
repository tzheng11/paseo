#!/usr/bin/env node
/**
 * Standalone latency acceptance runner; no serving runtime is started.
 *
 * From the repository root, on the designated benchmark host:
 *   node --experimental-strip-types packages/protocol/scripts/benchmark-secret-answer.mjs \
 *     --matrix --out /tmp/secret-answer-matrix
 *   node --experimental-strip-types packages/protocol/scripts/benchmark-secret-answer.mjs \
 *     --matrix --out /tmp/secret-answer-matrix --resume
 *
 * All values and inputs are synthetic. CI uses deterministic work counts instead
 * of wall-clock assertions. The default selection is the Manager's seven forms
 * plus the earlier and compound stress forms; --matrix adds the vocabulary cross-product.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SECRET_MANAGER_PERFORMANCE_FORMS,
  SECRET_PERFORMANCE_STRESS_FORMS,
  secretPerformanceMatrix,
} from "../tests/secret-answer-performance-fixtures.ts";

const ONE_MB = 1_000_000;
const FOUR_MB = 4_000_000;
const SAMPLES = 3;
const THROUGHPUT_LIMIT_MS = 1_500;
const FOUR_MB_RATIO_LIMIT = 4.8;
const SOURCE_URL = new URL("../src/secret-answer.ts", import.meta.url);
const FIXTURES_URL = new URL("../tests/secret-answer-performance-fixtures.ts", import.meta.url);
const HELP = `Usage: node --experimental-strip-types benchmark-secret-answer.mjs [options]

  --matrix         Include every vocabulary/operator/value form (17,727 rows,
                   including the seven Manager forms), plus earlier and compound stress forms.
  --only TEXT      Keep IDs or groups containing TEXT; repeat for alternatives.
                   Examples: --only manager, --only password-arrow, --only stress.
  --out PREFIX     Write PREFIX.meta.json, .source.ts, .jsonl, .4mb.jsonl and .json.
  --resume         Resume existing receipts only when source, fixtures and options match.
  --limit N        Stop after N new one-MB cases; resume later with identical selection.
  --api NAME       prompt (default), answer, or both. The Manager latency bar is prompt.
  --help           Show this message.

Every one-MB case uses exactly 1,000,000 UTF-8 bytes and median of three complete
calls after a 32 KB warmup. The slowest completed vocabulary row (or Manager row when no vocabulary is selected)
for each API is then measured separately at exactly 4,000,000 bytes; its median ratio must be <= 4.8.
Manager/vocabulary prompt cases must each be <= 1,500 ms. Stress and answer timings
are reported separately. No output text or secret value is printed or stored.
A full matrix is intentionally sequential and can take hours. --limit and --resume
preserve each completed row without changing the acceptance measurement.
`;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function optionValue(argv, index) {
  const argument = argv[index];
  const equals = argument.indexOf("=");
  if (equals >= 0) return [argument.slice(equals + 1), index];
  if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
    throw new Error(`Missing value for ${argument}`);
  }
  return [argv[index + 1], index + 1];
}

export function parseOptions(argv) {
  const options = {
    matrix: false,
    only: [],
    out: null,
    resume: false,
    limit: Infinity,
    api: "prompt",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index].split("=", 1)[0];
    if (name === "--help") options.help = true;
    else if (name === "--matrix") options.matrix = true;
    else if (name === "--resume") options.resume = true;
    else if (["--only", "--out", "--limit", "--api"].includes(name)) {
      let value;
      [value, index] = optionValue(argv, index);
      if (name === "--only") options.only.push(value);
      else if (name === "--out") options.out = resolve(value);
      else if (name === "--api") options.api = value;
      else options.limit = Number(value);
    } else throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (!["prompt", "answer", "both"].includes(options.api)) {
    throw new Error("--api must be prompt, answer, or both");
  }
  if (options.limit !== Infinity && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!options.out) {
    options.out = resolve(os.tmpdir(), `paseo-secret-answer-benchmark-${Date.now()}`);
  }
  options.only.sort();
  return options;
}

/** The final partial code point is padded with ASCII spaces, never split. */
export function fillToBytes({ prefix, unit, suffix = "" }, bytes) {
  const prefixBytes = Buffer.byteLength(prefix);
  const unitBytes = Buffer.byteLength(unit);
  const suffixBytes = Buffer.byteLength(suffix);
  if (unitBytes === 0 || bytes < prefixBytes + suffixBytes)
    throw new Error("Invalid fixture byte extent");
  const repeats = Math.floor((bytes - prefixBytes - suffixBytes) / unitBytes);
  let text = prefix + unit.repeat(repeats);
  let remaining = bytes - prefixBytes - suffixBytes - repeats * unitBytes;
  for (const character of suffix ? "" : unit) {
    const width = Buffer.byteLength(character);
    if (width > remaining) break;
    text += character;
    remaining -= width;
  }
  text += " ".repeat(remaining) + suffix;
  if (Buffer.byteLength(text) !== bytes) throw new Error("Fixture byte count mismatch");
  return text;
}

function selectedFixtures(options) {
  const forms = options.matrix
    ? [...secretPerformanceMatrix(), ...SECRET_PERFORMANCE_STRESS_FORMS]
    : [...SECRET_MANAGER_PERFORMANCE_FORMS, ...SECRET_PERFORMANCE_STRESS_FORMS];
  const selected = forms.filter(
    (form) =>
      options.only.length === 0 ||
      options.only.some((filter) => form.id.includes(filter) || form.group.includes(filter)),
  );
  if (selected.length === 0) throw new Error("No fixtures matched the selection");
  const ids = new Set(selected.map((form) => form.id));
  if (ids.size !== selected.length) throw new Error("Fixture IDs must be unique");
  return selected;
}

function readRows(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid receipt at ${path}:${index + 1}; preserve it before recovery`);
      }
    });
}

function median(values) {
  return [...values].sort((left, right) => left - right)[1];
}

function measure(redact, text) {
  const runsMs = [];
  let outputCharacters = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const started = performance.now();
    const output = redact(text);
    runsMs.push(performance.now() - started);
    outputCharacters = output.length;
  }
  return { runsMs, medianMs: median(runsMs), outputCharacters };
}

function receiptPaths(prefix) {
  return {
    meta: `${prefix}.meta.json`,
    source: `${prefix}.source.ts`,
    rows: `${prefix}.jsonl`,
    fourMB: `${prefix}.4mb.jsonl`,
    summary: `${prefix}.json`,
  };
}

function prepareReceipt(options, fixtures, source) {
  const paths = receiptPaths(options.out);
  const metadata = {
    version: 1,
    source: fileURLToPath(SOURCE_URL),
    sourceSha256: hash(source),
    runnerSha256: hash(readFileSync(new URL(import.meta.url))),
    benchmarkHost: os.hostname(),
    nodeVersion: process.version,
    fixtureSha256: hash(readFileSync(FIXTURES_URL)),
    selectionSha256: hash(JSON.stringify(fixtures)),
    selection: { matrix: options.matrix, only: options.only, api: options.api },
    bytes: ONE_MB,
    fourMBBytes: FOUR_MB,
    samples: SAMPLES,
    statistic: "median",
  };
  const present = Object.values(paths).filter((path) => existsSync(path));
  if (present.length > 0 && !options.resume) {
    throw new Error(`Receipt already exists; use --resume or choose another --out: ${options.out}`);
  }
  mkdirSync(dirname(options.out), { recursive: true });
  if (options.resume) {
    if (!existsSync(paths.meta) || !existsSync(paths.source)) {
      throw new Error("Resume requires both immutable metadata and frozen source files");
    }
    const old = JSON.parse(readFileSync(paths.meta, "utf8"));
    if (
      JSON.stringify(old) !== JSON.stringify(metadata) ||
      readFileSync(paths.source, "utf8") !== source
    ) {
      throw new Error(
        "Resume rejected: source, fixtures, selection or measurement options changed",
      );
    }
  } else {
    writeFileSync(paths.meta, JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
    writeFileSync(paths.source, source, { flag: "wx" });
  }
  return { paths, metadata };
}

function validateRows(rows, fixtures, readers, metadata, bytes) {
  const fixtureById = new Map(fixtures.map((form) => [form.id, form]));
  const apis = new Set(readers.map(([api]) => api));
  const completed = new Set();
  for (const row of rows) {
    const key = `${row.api}\0${row.id}`;
    if (
      row.sourceSha256 !== metadata.sourceSha256 ||
      row.bytes !== bytes ||
      !fixtureById.has(row.id) ||
      (bytes === ONE_MB && row.group !== fixtureById.get(row.id).group) ||
      !apis.has(row.api) ||
      completed.has(key) ||
      row.runsMs?.length !== SAMPLES ||
      !row.runsMs.every((value) => Number.isFinite(value) && value >= 0) ||
      row.medianMs !== median(row.runsMs)
    )
      throw new Error("Resume rejected: invalid, duplicate or mismatched timing row");
    completed.add(key);
  }
  return completed;
}

function scalingCase(rows, api) {
  const available = rows.filter((row) => row.api === api);
  const vocabulary = available.filter((row) => row.group === "vocabulary");
  const hardBars = available.filter((row) => row.group !== "stress");
  let candidates = available;
  if (vocabulary.length) candidates = vocabulary;
  else if (hardBars.length) candidates = hardBars;
  return candidates.reduce(
    (worst, row) => (!worst || row.medianMs > worst.medianMs ? row : worst),
    undefined,
  );
}

function summaryFor(metadata, fixtures, readers, rows, fourMBRows) {
  const worst = [...rows].sort((left, right) => right.medianMs - left.medianMs);
  const done = rows.length === fixtures.length * readers.length;
  const comparison4MB = fourMBRows.map((row) => ({
    ...row,
    ratio: row.medianMs / row.oneMBMedianMs,
    pass: row.medianMs / row.oneMBMedianMs <= FOUR_MB_RATIO_LIMIT,
  }));
  const promptBarMisses = rows.filter(
    (row) => row.api === "prompt" && row.group !== "stress" && row.medianMs > THROUGHPUT_LIMIT_MS,
  ).length;
  return {
    ...metadata,
    runtime: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      hostname: os.hostname(),
    },
    expectedOneMBCases: fixtures.length * readers.length,
    completedOneMBCases: rows.length,
    oneMBComplete: done,
    fourMBComplete: done && comparison4MB.length === readers.length,
    promptBarMisses,
    allCasesOver1500ms: rows.filter((row) => row.medianMs > THROUGHPUT_LIMIT_MS).length,
    worst: worst.slice(0, 20),
    scalingSelection: readers.map(([api]) => scalingCase(rows, api)).filter(Boolean),
    comparison4MB,
    pass:
      done &&
      comparison4MB.length === readers.length &&
      promptBarMisses === 0 &&
      comparison4MB.every((row) => row.pass),
    generatedAt: new Date().toISOString(),
  };
}

function saveSummary(paths, metadata, fixtures, readers, rows, fourMBRows) {
  const summary = summaryFor(metadata, fixtures, readers, rows, fourMBRows);
  writeFileSync(paths.summary, JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

async function benchmark(options) {
  const fixtures = selectedFixtures(options);
  const source = readFileSync(SOURCE_URL, "utf8");
  const { paths, metadata } = prepareReceipt(options, fixtures, source);
  const module = await import(pathToFileURL(paths.source).href);
  const readers = [
    ["prompt", module.redactSecretPrompt],
    ["answer", module.redactSecretAnswer],
  ].filter(([api]) => options.api === "both" || api === options.api);
  const rows = readRows(paths.rows);
  const fourMBRows = readRows(paths.fourMB);
  const completed = validateRows(rows, fixtures, readers, metadata, ONE_MB);
  validateRows(fourMBRows, fixtures, readers, metadata, FOUR_MB);
  let measured = 0;
  for (const fixture of fixtures) {
    if (measured >= options.limit) break;
    for (const [api, redact] of readers) {
      if (measured >= options.limit) break;
      const key = `${api}\0${fixture.id}`;
      if (completed.has(key)) continue;
      redact(fillToBytes(fixture, 32_000));
      const text = fillToBytes(fixture, ONE_MB);
      const row = {
        sourceSha256: metadata.sourceSha256,
        id: fixture.id,
        group: fixture.group,
        api,
        bytes: ONE_MB,
        inputCharacters: text.length,
        singleLine: !/[\r\n]/.test(text),
        ...measure(redact, text),
      };
      appendFileSync(paths.rows, JSON.stringify(row) + "\n");
      rows.push(row);
      completed.add(key);
      measured += 1;
      if (measured % 20 === 0) {
        const summary = saveSummary(paths, metadata, fixtures, readers, rows, fourMBRows);
        process.stderr.write(
          JSON.stringify({
            completed: rows.length,
            total: summary.expectedOneMBCases,
            promptBarMisses: summary.promptBarMisses,
            worstMs: summary.worst[0]?.medianMs,
          }) + "\n",
        );
      }
    }
  }
  if (rows.length === fixtures.length * readers.length) {
    for (const [api, redact] of readers) {
      const worst = scalingCase(rows, api);
      const old = fourMBRows.find((row) => row.api === api);
      if (old) {
        if (old.id !== worst.id || old.oneMBMedianMs !== worst.medianMs) {
          throw new Error("Four-MB receipt does not match the slowest one-MB case");
        }
        continue;
      }
      const fixture = fixtures.find((form) => form.id === worst.id);
      redact(fillToBytes(fixture, 32_000));
      const text = fillToBytes(fixture, FOUR_MB);
      const row = {
        sourceSha256: metadata.sourceSha256,
        id: fixture.id,
        group: fixture.group,
        api,
        bytes: FOUR_MB,
        oneMBMedianMs: worst.medianMs,
        inputCharacters: text.length,
        ...measure(redact, text),
      };
      appendFileSync(paths.fourMB, JSON.stringify(row) + "\n");
      fourMBRows.push(row);
    }
  }
  const summary = saveSummary(paths, metadata, fixtures, readers, rows, fourMBRows);
  console.log(
    JSON.stringify({
      summary: paths.summary,
      sourceSha256: metadata.sourceSha256,
      completed: rows.length,
      total: summary.expectedOneMBCases,
      promptBarMisses: summary.promptBarMisses,
      pass: summary.pass,
      comparison4MB: summary.comparison4MB,
    }),
  );
  if (summary.oneMBComplete && !summary.pass) process.exitCode = 1;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }
  await benchmark(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
