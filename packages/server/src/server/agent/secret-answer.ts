import { AgentAttachmentSchema, TextAttachmentSchema } from "@getpaseo/protocol/messages";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import {
  redactSecretAnswer,
  redactSecretKey,
  redactSecretPrompt,
  secretPromptSpans,
  SECRET_ANSWER_NOTICE,
  type SecretPromptSpan,
} from "@getpaseo/protocol/secret-answer";
import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptContentBlock,
  AgentPromptInput,
} from "./agent-sdk-types.js";

export { redactSecretAnswer, SECRET_ANSWER_NOTICE };

const MAX_DEPTH = 12;
const MAX_ENTRIES = 5_000;
const MAX_CHARACTERS = 262_144;
const SECRET_METADATA_KEY =
  /(?:^|[_ .-])(?:secret|hmac|passwd|password|passphrase|credential|authorization|relay[_-]?key|daemon[_-]?public[_-]?key[_-]?b64|private[_-]?key|access[_-]?key|api[_-]?key|auth[_-]?token|bearer[_-]?token|session[_-]?token)$/i;

interface ScanBudget {
  entries: number;
  characters: number;
}

interface QuestionAnswerContext {
  text: string;
  options: ReadonlySet<string>;
}

interface AnswerContext extends QuestionAnswerContext {
  questions: ReadonlyMap<string, QuestionAnswerContext>;
  answerMap: boolean;
}

const NO_OPTIONS: ReadonlySet<string> = new Set();

function offeredOptions(value: unknown): ReadonlySet<string> {
  const options = new Set<string>();
  if (!Array.isArray(value)) return options;
  for (const option of value) {
    if (typeof option === "string") options.add(option);
    else if (isRecord(option)) {
      for (const label of [option.label, option.value, option.id]) {
        if (typeof label === "string") options.add(label);
      }
    }
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExplicitSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return SECRET_METADATA_KEY.test(words);
}

function isSecretMetadataAssignment(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  const assignment = `${key}=${value}`;
  return redactSecretKey(assignment) !== assignment;
}

function questionContexts(
  request?: AgentPermissionRequest,
): ReadonlyMap<string, QuestionAnswerContext> {
  const contexts = new Map<string, QuestionAnswerContext>();
  const questions = request?.input?.questions;
  if (!Array.isArray(questions)) {
    contexts.set("", {
      text: requestContext(request),
      options: offeredOptions(request?.input?.options),
    });
    return contexts;
  }
  if (questions.length > MAX_ENTRIES) {
    contexts.set("", { text: "password", options: NO_OPTIONS });
    return contexts;
  }
  const allContexts: string[] = [];
  const allOptions = new Set<string>();
  let characters = 0;
  for (const [index, question] of questions.entries()) {
    if (!isRecord(question)) continue;
    const substantive = [question.question, question.prompt, question.description].filter(
      (part): part is string => typeof part === "string" && part.trim() !== "",
    );
    const labels = [question.title, question.header];
    const label =
      labels.find((part): part is string => typeof part === "string" && part.trim() !== "") ?? "";
    const questionText = substantive.length > 0 ? substantive.join("\n") : label;
    const text = [questionText, request?.description]
      .filter((part) => part !== undefined)
      .join("\n");
    characters += text.length;
    if (characters > MAX_CHARACTERS)
      return new Map([["", { text: "password", options: NO_OPTIONS }]]);
    allContexts.push(text);
    const options = offeredOptions(question.options);
    for (const option of options) allOptions.add(option);
    const context = { text, options };
    contexts.set(String(index), context);
    contexts.set(`Question ${index + 1}`, context);
    for (const identifier of [
      question.id,
      question.header,
      question.title,
      question.question,
      question.prompt,
    ]) {
      if (typeof identifier === "string") {
        contexts.set(identifier, context);
        contexts.set(identifier.trim(), context);
      }
    }
  }
  contexts.set("", { text: allContexts.join("\n"), options: allOptions });
  return contexts;
}

function requestContext(request?: AgentPermissionRequest): string {
  if (!request) return "";
  const questions = request.input?.questions;
  if (Array.isArray(questions)) {
    if (questions.length > MAX_ENTRIES) return "password";
    const substantive = questions.some((question) => {
      if (!isRecord(question)) return false;
      return [question.question, question.prompt, question.title, question.description].some(
        (part) => typeof part === "string" && part.trim() !== "",
      );
    });
    if (substantive) return request.description ?? "";
  }
  const parts = [
    request.title,
    request.description,
    request.input?.question,
    request.input?.prompt,
    request.input?.title,
    request.input?.description,
    request.input?.header,
  ];
  return parts.filter((part): part is string => typeof part === "string").join("\n");
}

function redactValue(
  value: unknown,
  context: AnswerContext,
  budget: ScanBudget,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH || budget.entries <= 0) return SECRET_ANSWER_NOTICE;
  budget.entries -= 1;
  if (typeof value === "string") {
    if (context.options.has(value)) return value;
    budget.characters -= value.length;
    if (budget.characters < 0) return SECRET_ANSWER_NOTICE;
    return redactSecretAnswer(value, context.text);
  }
  if (Array.isArray(value)) {
    if (value.length > budget.entries) return SECRET_ANSWER_NOTICE;
    return value.map((item, index) => {
      if (!context.answerMap) return redactValue(item, context, budget, depth + 1);
      const question = context.questions.get(String(index)) ?? context.questions.get("");
      const itemContext = { ...context, ...question, answerMap: false };
      return redactValue(item, itemContext, budget, depth + 1);
    });
  }
  if (!isRecord(value)) return value;
  return redactObject(value, context, budget, depth);
}

function redactObject(
  value: AgentMetadata,
  context: AnswerContext,
  budget: ScanBudget,
  depth: number,
): AgentMetadata | string {
  const entries = Object.entries(value);
  if (entries.length > budget.entries) return SECRET_ANSWER_NOTICE;
  const redacted: AgentMetadata = {};
  for (const [index, [key, item]] of entries.entries()) {
    budget.characters -= key.length;
    const checkedKey = redactSecretKey(key);
    const keyWasWithheld = checkedKey !== key || budget.characters < 0;
    const safeKey = keyWasWithheld ? `[redacted:secret-key-${index}]` : key;
    const question = context.answerMap
      ? (context.questions.get(key) ?? context.questions.get(""))
      : undefined;
    const namedSecret = !context.answerMap && isExplicitSecretKey(key);
    const answerField = /^(?:answer|text|message|feedback)$/.test(key);
    const directAnswer = answerField ? context.questions.get("") : undefined;
    const valueContext = question ?? directAnswer ?? context;
    const nextContext = {
      ...valueContext,
      text: namedSecret ? "password" : valueContext.text,
      questions: context.questions,
      answerMap: key === "answers" && !context.answerMap,
    };
    const offered = typeof item === "string" && nextContext.options.has(item);
    const assignmentWasWithheld =
      !offered && !context.answerMap && isSecretMetadataAssignment(key, item);
    const safeValue =
      keyWasWithheld || assignmentWasWithheld
        ? SECRET_ANSWER_NOTICE
        : redactValue(item, nextContext, budget, depth + 1);
    Object.defineProperty(redacted, safeKey, {
      value: safeValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return redacted;
}

function redactMetadata(metadata: AgentMetadata, context: AnswerContext): AgentMetadata {
  const budget = { entries: MAX_ENTRIES, characters: MAX_CHARACTERS };
  const redacted = redactValue(metadata, context, budget);
  return isRecord(redacted) ? redacted : { redacted: SECRET_ANSWER_NOTICE };
}

/** Sanitize every answer-bearing response field before provider or persistence code sees it. */
export function redactPermissionResponse(
  response: AgentPermissionResponse,
  request?: AgentPermissionRequest,
): AgentPermissionResponse {
  const text = requestContext(request);
  const questions = questionContexts(request);
  const context = {
    text,
    questions,
    options: Array.isArray(request?.input?.questions)
      ? NO_OPTIONS
      : (questions.get("")?.options ?? NO_OPTIONS),
    answerMap: false,
  };
  const selectedActionId = response.selectedActionId;
  const safeAction =
    selectedActionId === undefined ? {} : { selectedActionId: redactSecretKey(selectedActionId) };
  if (response.behavior === "deny") {
    const questionText = [...questions.values()].map((question) => question.text).join("\n");
    const messageContext = `${text}\n${questionText}`;
    const message = response.message;
    const safeMessage =
      message === undefined
        ? {}
        : {
            message: questions.get("")?.options.has(message)
              ? message
              : redactSecretAnswer(message, messageContext),
          };
    return { ...response, ...safeAction, ...safeMessage };
  }
  const updatedInput = response.updatedInput;
  const safeInput =
    updatedInput === undefined ? {} : { updatedInput: redactMetadata(updatedInput, context) };
  const updatedPermissions = response.updatedPermissions;
  const permissionContext = { text: "", questions, options: NO_OPTIONS, answerMap: false };
  const safePermissions =
    updatedPermissions === undefined
      ? {}
      : {
          updatedPermissions:
            updatedPermissions.length > MAX_ENTRIES
              ? [{ redacted: SECRET_ANSWER_NOTICE }]
              : updatedPermissions.map((permission) =>
                  redactMetadata(permission, permissionContext),
                ),
        };
  return { ...response, ...safeAction, ...safeInput, ...safePermissions };
}

function redactPromptMetadata(value: unknown): unknown {
  if (typeof value === "string") return redactSecretPrompt(value);
  if (Array.isArray(value)) return value.map(redactPromptMetadata);
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).map(([key, item]) => [
    redactSecretKey(key),
    redactPromptMetadata(item),
  ]);
  return Object.fromEntries(entries);
}

/** Name generation receives the same safe prompt and attachment values as a provider turn. */
export function redactFirstAgentContext(context: FirstAgentContext): FirstAgentContext {
  return {
    ...context,
    ...(context.prompt === undefined ? {} : { prompt: redactSecretPrompt(context.prompt) }),
    ...(context.attachments === undefined
      ? {}
      : {
          attachments: context.attachments.map((attachment) =>
            AgentAttachmentSchema.parse(redactPromptMetadata(attachment)),
          ),
        }),
  };
}

interface PromptTextCursor {
  offset: number;
  spanIndex: number;
  spans: readonly SecretPromptSpan[];
}

/** A secret crossing blocks gets one notice, while each ordinary fragment stays in its block. */
function redactJoinedTextBlock(text: string, cursor: PromptTextCursor): string {
  const start = cursor.offset;
  const end = start + text.length;
  cursor.offset = end;
  const parts: string[] = [];
  let position = start;
  while (cursor.spanIndex < cursor.spans.length) {
    const span = cursor.spans[cursor.spanIndex]!;
    if (span.start >= end) break;
    if (span.end <= start) {
      cursor.spanIndex += 1;
      continue;
    }
    const overlapStart = Math.max(span.start, start);
    parts.push(text.slice(position - start, overlapStart - start));
    if (span.start >= start) parts.push(SECRET_ANSWER_NOTICE);
    position = Math.min(span.end, end);
    if (span.end > end) break;
    cursor.spanIndex += 1;
  }
  parts.push(text.slice(position - start));
  return parts.join("");
}

function redactPromptBlock(
  block: AgentPromptContentBlock,
  cursor: PromptTextCursor,
): AgentPromptContentBlock {
  if (block.type === "image") return block;
  if (block.type !== "text") return AgentAttachmentSchema.parse(redactPromptMetadata(block));
  const text = redactJoinedTextBlock(block.text, cursor);
  if (!("mimeType" in block)) return { ...block, text };
  const attachment = TextAttachmentSchema.parse(redactPromptMetadata(block));
  return { ...attachment, text };
}

/** All prompt entrypoints share span redaction; context is the latest actual assistant message. */
export function redactPromptInput(prompt: AgentPromptInput, context?: string): AgentPromptInput {
  if (typeof prompt === "string") return redactSecretPrompt(prompt, context);
  if (!Array.isArray(prompt)) return SECRET_ANSWER_NOTICE;
  // Providers concatenate text blocks. Detect that same view, then map spans to the original blocks.
  const textBlocks = prompt.filter((block) => block.type === "text");
  const text = textBlocks.map((block) => block.text).join("");
  const cursor: PromptTextCursor = {
    offset: 0,
    spanIndex: 0,
    spans: secretPromptSpans(text, context),
  };
  return prompt.map((block) => redactPromptBlock(block, cursor));
}
