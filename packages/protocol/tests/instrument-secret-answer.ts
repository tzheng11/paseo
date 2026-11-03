import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

interface WorkCounters {
  loops: number;
  entries: number;
}

export interface SecretAnswerWorkCounts extends WorkCounters {
  total: number;
}

type Reader = (text: string, context?: string) => string;

interface InstrumentedExports {
  redactSecretPrompt: Reader;
  redactSecretAnswer: Reader;
  __secretScannerWork: WorkCounters;
}

export interface InstrumentedSecretAnswer {
  sourceSha256: string;
  readers: readonly [readonly ["prompt", Reader], readonly ["answer", Reader]];
  reset(): void;
  counts(): SecretAnswerWorkCounts;
}

const factory = ts.factory;

function increment(name: keyof WorkCounters): ts.Statement {
  return factory.createExpressionStatement(
    factory.createPostfixUnaryExpression(
      factory.createPropertyAccessExpression(factory.createIdentifier("__secretScannerWork"), name),
      ts.SyntaxKind.PlusPlusToken,
    ),
  );
}

function countedBody(body: ts.Statement, name: keyof WorkCounters): ts.Block {
  return ts.isBlock(body)
    ? factory.updateBlock(body, [increment(name), ...body.statements])
    : factory.createBlock([increment(name), body], true);
}

function countLoop(node: ts.Node): ts.Node {
  if (ts.isForStatement(node)) {
    return factory.updateForStatement(
      node,
      node.initializer,
      node.condition,
      node.incrementor,
      countedBody(node.statement, "loops"),
    );
  }
  if (ts.isForOfStatement(node)) {
    return factory.updateForOfStatement(
      node,
      node.awaitModifier,
      node.initializer,
      node.expression,
      countedBody(node.statement, "loops"),
    );
  }
  if (ts.isForInStatement(node)) {
    return factory.updateForInStatement(
      node,
      node.initializer,
      node.expression,
      countedBody(node.statement, "loops"),
    );
  }
  if (ts.isWhileStatement(node)) {
    return factory.updateWhileStatement(
      node,
      node.expression,
      countedBody(node.statement, "loops"),
    );
  }
  if (ts.isDoStatement(node)) {
    return factory.updateDoStatement(node, countedBody(node.statement, "loops"), node.expression);
  }
  return node;
}

function countFunction(node: ts.Node): ts.Node {
  if (ts.isFunctionDeclaration(node) && node.body) {
    return factory.updateFunctionDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      countedBody(node.body, "entries"),
    );
  }
  if (ts.isFunctionExpression(node)) {
    return factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      countedBody(node.body, "entries"),
    );
  }
  if (ts.isMethodDeclaration(node) && node.body) {
    return factory.updateMethodDeclaration(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.questionToken,
      node.typeParameters,
      node.parameters,
      node.type,
      countedBody(node.body, "entries"),
    );
  }
  if (ts.isConstructorDeclaration(node) && node.body) {
    return factory.updateConstructorDeclaration(
      node,
      node.modifiers,
      node.parameters,
      countedBody(node.body, "entries"),
    );
  }
  if (ts.isArrowFunction(node)) {
    const body = ts.isBlock(node.body)
      ? countedBody(node.body, "entries")
      : factory.createBlock([increment("entries"), factory.createReturnStatement(node.body)], true);
    return factory.updateArrowFunction(
      node,
      node.modifiers,
      node.typeParameters,
      node.parameters,
      node.type,
      node.equalsGreaterThanToken,
      body,
    );
  }
  return node;
}

function instrumentSource(sourceText: string): string {
  const source = ts.createSourceFile(
    "secret-answer.ts",
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const transformed = ts.transform(source, [
    (context) => {
      const visit: ts.Visitor = (original) => {
        const node = ts.visitEachChild(original, visit, context);
        return countFunction(countLoop(node));
      };
      return (root) => ts.visitNode(root, visit) as ts.SourceFile;
    },
  ]);
  try {
    const printed = ts.createPrinter().printFile(transformed.transformed[0]!);
    return ts.transpileModule(printed, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
  } finally {
    transformed.dispose();
  }
}

let cached: InstrumentedSecretAnswer | undefined;

/**
 * Compiles one isolated, test-only copy of the actual scanner. Explicit loop
 * iterations and helper/callback entries are counted deterministically; the
 * serving module and its exports are unchanged. Regex-engine internals are not
 * counted, so the standalone median-of-three benchmark remains the latency gate.
 */
export function instrumentSecretAnswer(): InstrumentedSecretAnswer {
  if (cached) return cached;
  const sourceText = readFileSync(new URL("../src/secret-answer.ts", import.meta.url), "utf8");
  const counters: WorkCounters = { loops: 0, entries: 0 };
  const compiled = instrumentSource(sourceText);
  const instantiate = new Script(
    `(function(exports, __secretScannerWork) { ${compiled}\nreturn exports; })`,
    { filename: "instrumented-secret-answer.cjs" },
  ).runInThisContext() as (
    exports: Partial<InstrumentedExports>,
    counters: WorkCounters,
  ) => InstrumentedExports;
  const module = instantiate({}, counters);
  cached = {
    sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    readers: [
      ["prompt", module.redactSecretPrompt],
      ["answer", module.redactSecretAnswer],
    ],
    reset() {
      counters.loops = 0;
      counters.entries = 0;
    },
    counts() {
      return { ...counters, total: counters.loops + counters.entries };
    },
  };
  return cached;
}
