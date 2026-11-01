import type { PersistStorage } from "zustand/middleware";
import { redactSecretAnswer } from "@getpaseo/protocol/secret-answer";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { DraftRecord, DraftStoreState } from "./state";

export interface DraftAnswerContext {
  pendingQuestions: readonly AgentPermissionRequest[];
  latestMessage?: { kind: "user_message" | "assistant_message"; text: string };
}

const MAX_DRAFT_CONTEXT_ENTRIES = 5_000;
const MAX_DRAFT_CONTEXT_CHARACTERS = 65_536;
const INCOMPLETE_DRAFT_CONTEXT = "Enter your password.";
const SUBSTANTIVE_QUESTION_FIELDS = ["question", "prompt", "description"] as const;
const QUESTION_LABEL_FIELDS = ["title", "header"] as const;

function textFields(question: object, fields: readonly string[]): string[] {
  return fields
    .map((field): unknown => Reflect.get(question, field))
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

function questionTexts(question: object): string[] {
  const substantive = textFields(question, SUBSTANTIVE_QUESTION_FIELDS);
  return substantive.length > 0
    ? substantive
    : textFields(question, QUESTION_LABEL_FIELDS).slice(0, 1);
}

function structuredQuestionTexts(question: unknown): string[] {
  if (typeof question === "string") return question.trim() ? [question] : [];
  if (question !== null && typeof question === "object" && !Array.isArray(question)) {
    return questionTexts(question);
  }
  return [];
}

function requestFallbackTexts(request: AgentPermissionRequest): Array<string | undefined> {
  const substantive = [
    ...(request.input ? textFields(request.input, SUBSTANTIVE_QUESTION_FIELDS) : []),
    ...textFields(request, ["description"]),
  ];
  if (substantive.length > 0) return substantive;
  const inputLabels = request.input ? textFields(request.input, QUESTION_LABEL_FIELDS) : [];
  if (inputLabels.length > 0) return inputLabels.slice(0, 1);
  return [request.title];
}

interface DraftContextCollector {
  texts: string[];
  entries: number;
  characters: number;
}

function appendContext(collector: DraftContextCollector, value: unknown): boolean {
  if (typeof value !== "string") return true;
  collector.characters += value.length + 1;
  if (collector.characters > MAX_DRAFT_CONTEXT_CHARACTERS) return false;
  collector.texts.push(value);
  return true;
}

function appendContextTexts(collector: DraftContextCollector, values: readonly unknown[]): boolean {
  return values.every((value) => appendContext(collector, value));
}

function collectRequestContext(
  collector: DraftContextCollector,
  request: AgentPermissionRequest,
): boolean {
  if (request.kind !== "question") return true;
  const structuredQuestions = request.input?.questions;
  const previousCount = collector.texts.length;
  if (Array.isArray(structuredQuestions)) {
    collector.entries += structuredQuestions.length;
    if (collector.entries > MAX_DRAFT_CONTEXT_ENTRIES) return false;
    for (const question of structuredQuestions) {
      if (!appendContextTexts(collector, structuredQuestionTexts(question))) return false;
    }
  }
  // A generic card title or answer label must not override a substantive question.
  const texts =
    collector.texts.length === previousCount
      ? requestFallbackTexts(request)
      : [request.description];
  return appendContextTexts(collector, texts);
}

/** Only the latest unanswered assistant request can make an unshaped draft sensitive. */
export function draftAnswerContext(input: DraftAnswerContext): string {
  if (input.pendingQuestions.length > MAX_DRAFT_CONTEXT_ENTRIES) return INCOMPLETE_DRAFT_CONTEXT;
  const collector: DraftContextCollector = { texts: [], entries: 0, characters: 0 };
  for (const request of input.pendingQuestions) {
    if (!collectRequestContext(collector, request)) return INCOMPLETE_DRAFT_CONTEXT;
  }
  const latest = input.latestMessage;
  if (latest?.kind === "assistant_message" && !appendContext(collector, latest.text)) {
    return INCOMPLETE_DRAFT_CONTEXT;
  }
  return collector.texts.join("\n");
}

/** Copy at the persistence boundary so the live editor keeps its unsaved text. */
export function redactPersistedDrafts(
  state: DraftStoreState,
  contextForDraft: (draftKey: string) => string = () => "",
): DraftStoreState {
  const redact = (record: DraftRecord, context?: string): DraftRecord => ({
    ...record,
    input: { ...record.input, text: redactSecretAnswer(record.input.text, context) },
  });
  return {
    drafts: Object.fromEntries(
      Object.entries(state.drafts).map(([key, record]) => [
        key,
        redact(record, contextForDraft(key)),
      ]),
    ),
    createModalDraft: state.createModalDraft ? redact(state.createModalDraft) : null,
  };
}

export const DRAFT_PERSIST_INTERVAL_MS = 200;
export interface PersistenceScheduler {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
}

export interface DraftPersistStorage<T> extends PersistStorage<T> {
  flush: () => Promise<void>;
}

let nextSystemTimerId = 0;
const systemTimers = new Map<number, ReturnType<typeof setTimeout>>();
const systemScheduler: PersistenceScheduler = {
  now: Date.now,
  schedule: (callback, delayMs) => {
    const id = nextSystemTimerId++;
    systemTimers.set(
      id,
      setTimeout(() => {
        systemTimers.delete(id);
        callback();
      }, delayMs),
    );
    return id;
  },
  cancel: (handle) => {
    if (typeof handle !== "number") return;
    const timer = systemTimers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    systemTimers.delete(handle);
  },
};

export function createDraftPersistStorage<T>(
  storage: PersistStorage<T>,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T>;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler?: PersistenceScheduler,
): DraftPersistStorage<T> | undefined;
export function createDraftPersistStorage<T>(
  storage: PersistStorage<T> | undefined,
  scheduler: PersistenceScheduler = systemScheduler,
): DraftPersistStorage<T> | undefined {
  if (!storage) {
    return undefined;
  }

  let pending: { name: string; value: Parameters<typeof storage.setItem>[1] } | null = null;
  let timer: unknown = null;
  let lastWriteAt = -Infinity;

  const cancelTimer = () => {
    if (timer !== null) {
      scheduler.cancel(timer);
      timer = null;
    }
  };
  const flush = async (): Promise<void> => {
    cancelTimer();
    const write = pending;
    pending = null;
    if (!write) {
      return;
    }
    lastWriteAt = scheduler.now();
    try {
      await storage.setItem(write.name, write.value);
    } catch (error) {
      console.warn("[DraftStore] Failed to persist draft checkpoint", error);
    }
  };

  return {
    getItem: (name) => storage.getItem(name),
    setItem: (name, value) => {
      pending = { name, value };
      const delay = DRAFT_PERSIST_INTERVAL_MS - (scheduler.now() - lastWriteAt);
      if (delay <= 0) {
        return flush();
      }
      timer ??= scheduler.schedule(() => {
        void flush();
      }, delay);
    },
    removeItem: (name) => {
      cancelTimer();
      pending = null;
      lastWriteAt = scheduler.now();
      return storage.removeItem(name);
    },
    flush,
  };
}
