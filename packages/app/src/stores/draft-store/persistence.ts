import type { PersistStorage } from "zustand/middleware";
import { redactSecretPrompt } from "@getpaseo/protocol/secret-answer";
import type { DraftRecord, DraftStoreState } from "./state";

export interface DraftAnswerContext {
  latestMessage?: { kind: "user_message" | "assistant_message"; text: string };
}

/** Composer drafts are chat, so only the latest actual assistant message supplies context. */
export function draftAnswerContext(input: DraftAnswerContext): string {
  return input.latestMessage?.kind === "assistant_message" ? input.latestMessage.text : "";
}

/** Copy at the persistence boundary so the live editor keeps its unsaved text. */
export function redactPersistedDrafts(
  state: DraftStoreState,
  contextForDraft: (draftKey: string) => string = () => "",
): DraftStoreState {
  const redact = (record: DraftRecord, context?: string): DraftRecord => ({
    ...record,
    input: { ...record.input, text: redactSecretPrompt(record.input.text, context) },
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
