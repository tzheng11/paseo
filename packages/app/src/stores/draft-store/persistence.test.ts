import { describe, expect, it } from "vitest";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import { SECRET_ANSWER_NOTICE } from "@getpaseo/protocol/secret-answer";
import {
  createDraftPersistStorage,
  draftAnswerContext,
  DRAFT_PERSIST_INTERVAL_MS,
  redactPersistedDrafts,
  type PersistenceScheduler,
} from "./persistence";
import type { DraftRecord, DraftStoreState } from "./state";

interface DraftState {
  text: string;
}

function createDraftPersistence() {
  let nowMs = 0;
  let saved: StorageValue<DraftState> | null = null;
  let scheduled: { callback: () => void; dueAt: number } | null = null;
  const storage: PersistStorage<DraftState> = {
    getItem: () => saved,
    setItem: (_name, value) => {
      saved = value;
    },
    removeItem: () => {
      saved = null;
    },
  };
  const scheduler: PersistenceScheduler = {
    now: () => nowMs,
    schedule: (callback, delayMs) => (scheduled = { callback, dueAt: nowMs + delayMs }),
    cancel: () => {
      scheduled = null;
    },
  };
  const drafts = createDraftPersistStorage(storage, scheduler);

  return {
    save(text: string) {
      drafts.setItem("drafts", { state: { text } });
    },
    remove() {
      drafts.removeItem("drafts");
    },
    flush() {
      return drafts.flush();
    },
    advance(ms: number) {
      nowMs += ms;
      if (scheduled && scheduled.dueAt <= nowMs) {
        const { callback } = scheduled;
        scheduled = null;
        callback();
      }
    },
    text() {
      return saved?.state.text ?? null;
    },
  };
}

describe("draft persistence", () => {
  it("checkpoints the first change and the latest change in each interval", () => {
    const drafts = createDraftPersistence();

    drafts.save("a");
    drafts.save("ab");
    drafts.save("abc");
    expect(drafts.text()).toBe("a");

    drafts.advance(DRAFT_PERSIST_INTERVAL_MS - 1);
    expect(drafts.text()).toBe("a");

    drafts.advance(1);
    expect(drafts.text()).toBe("abc");
  });

  it("does not restore a pending draft after storage is cleared", () => {
    const drafts = createDraftPersistence();

    drafts.save("first checkpoint");
    drafts.save("pending checkpoint");
    drafts.remove();
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);

    expect(drafts.text()).toBeNull();
  });

  it("continues checkpointing the latest change across consecutive intervals", () => {
    const drafts = createDraftPersistence();

    drafts.save("first");
    drafts.save("first interval");
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);
    expect(drafts.text()).toBe("first interval");

    drafts.save("second");
    drafts.save("second interval");
    drafts.advance(DRAFT_PERSIST_INTERVAL_MS);
    expect(drafts.text()).toBe("second interval");
  });

  it("flushes the latest pending change before the interval ends", async () => {
    const drafts = createDraftPersistence();

    drafts.save("first checkpoint");
    drafts.save("pending checkpoint");
    await drafts.flush();

    expect(drafts.text()).toBe("pending checkpoint");
  });

  it("withholds synthetic secrets from durable draft checkpoints without changing the editor", async () => {
    const syntheticSecret = `sk-proj-${"synthetic".repeat(8)}`;
    const record = (text: string): DraftRecord => ({
      input: { text, attachments: [] },
      lifecycle: "active",
      updatedAt: 1,
      version: 1,
    });
    const editorState: DraftStoreState = {
      drafts: {
        "agent:host:agent": record(syntheticSecret),
        "agent:host:ordinary": record("Use the existing implementation."),
      },
      createModalDraft: record(`API_KEY=${syntheticSecret}`),
    };
    let saved: StorageValue<DraftStoreState> | null = null;
    const storage: PersistStorage<DraftStoreState> = {
      getItem: () => saved,
      setItem: (_name, value) => {
        saved = value;
      },
      removeItem: () => {
        saved = null;
      },
    };
    const drafts = createDraftPersistStorage(storage);
    drafts.setItem("drafts", { state: redactPersistedDrafts(editorState) });
    await drafts.flush();

    const checkpoint = await storage.getItem("drafts");
    expect(JSON.stringify(checkpoint)).not.toContain(syntheticSecret);
    expect(checkpoint?.state.drafts["agent:host:agent"].input.text).toBe(SECRET_ANSWER_NOTICE);
    expect(checkpoint?.state.createModalDraft?.input.text).toBe(`API_KEY=${SECRET_ANSWER_NOTICE}`);
    expect(checkpoint?.state.drafts["agent:host:ordinary"].input.text).toBe(
      "Use the existing implementation.",
    );
    expect(editorState.drafts["agent:host:agent"].input.text).toBe(syntheticSecret);
  });

  const checkpoint = (text: string, context = "") => {
    const state: DraftStoreState = {
      drafts: {
        "agent:host:agent": {
          input: { text, attachments: [] },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    };
    return redactPersistedDrafts(state, () => context).drafts["agent:host:agent"].input.text;
  };

  it("uses only the latest assistant message as draft context", () => {
    expect(
      draftAnswerContext({ latestMessage: { kind: "assistant_message", text: "Password:" } }),
    ).toBe("Password:");
    expect(draftAnswerContext({ latestMessage: { kind: "user_message", text: "Password:" } })).toBe(
      "",
    );
    expect(draftAnswerContext({})).toBe("");
  });

  it("withholds single-token replies only after a strict request at the end", () => {
    expect(checkpoint("x", "Please provide your password.")).toBe(SECRET_ANSWER_NOTICE);
    expect(checkpoint("x", "Password:")).toBe(SECRET_ANSWER_NOTICE);
    expect(checkpoint("x", "Please provide your password. Meanwhile, tests pass.")).toBe("x");
    expect(checkpoint("yes go ahead", "Please provide your password.")).toBe("yes go ahead");
    expect(checkpoint("yes", "Which key should I use for the React list?")).toBe("yes");
    expect(checkpoint("x", "x".repeat(65_537))).toBe("x");
  });

  it("preserves text around synthetic keys in all durable drafts", () => {
    const key = `sk-proj-${"synthetic".repeat(8)}`;
    expect(checkpoint(`  before\n${key}\nafter  `)).toBe(
      `  before\n${SECRET_ANSWER_NOTICE}\nafter  `,
    );
    expect(checkpoint("log line without anything sensitive in it\n".repeat(1800))).toBe(
      "log line without anything sensitive in it\n".repeat(1800),
    );
  });

  it.each([
    "The secret-scan: required check failed on this PR, please look.",
    "Why does this fail? const client = new S3({ accessKeyId: process.env.KEY_ID })",
    "Fix this yaml:\n  secretName: my-app-config\n  image: nginx",
    "In the schema, password: required for local accounts only.",
  ])("preserves ordinary draft bytes: %s", (text) => {
    expect(checkpoint(text)).toBe(text);
  });
});
