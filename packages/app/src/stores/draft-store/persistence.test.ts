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
    expect(checkpoint?.state.createModalDraft?.input.text).toBe(SECRET_ANSWER_NOTICE);
    expect(checkpoint?.state.drafts["agent:host:ordinary"].input.text).toBe(
      "Use the existing implementation.",
    );
    expect(editorState.drafts["agent:host:agent"].input.text).toBe(syntheticSecret);
  });

  it("withholds any draft shape when a pending question asks for a credential", () => {
    const state: DraftStoreState = {
      drafts: {
        "agent:host:agent": {
          input: { text: "synthetic-short-password", attachments: [] },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    };
    const context = draftAnswerContext({
      pendingQuestions: [
        {
          id: "question",
          provider: "codex",
          kind: "question",
          name: "request_user_input_async",
          input: { questions: [{ question: "Enter your Mac password" }] },
        },
      ],
    });

    expect(redactPersistedDrafts(state, () => context).drafts["agent:host:agent"].input.text).toBe(
      SECRET_ANSWER_NOTICE,
    );
    expect(JSON.stringify(redactPersistedDrafts(state, () => context))).not.toContain(
      "synthetic-short-password",
    );
  });

  it("withholds tiny drafts for bare structured credential prompts", () => {
    const state: DraftStoreState = {
      drafts: {
        "agent:host:agent": {
          input: { text: "x", attachments: [] },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    };
    for (const field of ["question", "title", "header"]) {
      const context = draftAnswerContext({
        pendingQuestions: [
          {
            id: "question",
            provider: "codex",
            kind: "question",
            name: "request_user_input_async",
            title: "Questions",
            input: { questions: [{ id: "password", [field]: "Password" }] },
          },
        ],
      });
      expect(context.split("\n")).toContain("Password");
      expect(
        redactPersistedDrafts(state, () => context).drafts["agent:host:agent"].input.text,
      ).toBe(SECRET_ANSWER_NOTICE);
    }
  });

  it("withholds credential replies in chat and oversized contexts while preserving ordinary answers", () => {
    const state: DraftStoreState = {
      drafts: {
        "agent:host:agent": {
          input: { text: "x", attachments: [] },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    };
    const checkpoint = (kind: "assistant_message" | "user_message", text: string) => {
      const context = draftAnswerContext({ pendingQuestions: [], latestMessage: { kind, text } });
      return redactPersistedDrafts(state, () => context).drafts["agent:host:agent"].input.text;
    };
    expect(checkpoint("assistant_message", "Please provide your password.")).toBe(
      SECRET_ANSWER_NOTICE,
    );
    expect(checkpoint("assistant_message", "Password")).toBe(SECRET_ANSWER_NOTICE);
    expect(checkpoint("assistant_message", "I fixed token validation.")).toBe("x");
    expect(checkpoint("assistant_message", "Which token budget should we use?")).toBe("x");
    expect(checkpoint("user_message", "Please update the password field.")).toBe("x");
    expect(checkpoint("assistant_message", "x".repeat(65_537))).toBe(SECRET_ANSWER_NOTICE);
    const oversizedQuestions = draftAnswerContext({
      pendingQuestions: [
        {
          id: "question",
          provider: "codex",
          kind: "question",
          name: "question",
          input: { questions: Array.from({ length: 5_001 }, () => ({ question: "Where?" })) },
        },
      ],
    });
    expect(
      redactPersistedDrafts(state, () => oversizedQuestions).drafts["agent:host:agent"].input.text,
    ).toBe(SECRET_ANSWER_NOTICE);
  });

  it("uses the substantive question instead of a credential-shaped header for ordinary drafts", () => {
    const state: DraftStoreState = {
      drafts: {
        "agent:host:agent": {
          input: { text: "yes", attachments: [] },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    };
    const context = draftAnswerContext({
      pendingQuestions: [
        {
          id: "question",
          provider: "codex",
          kind: "question",
          name: "question",
          title: "Password",
          input: {
            questions: [{ header: "Password", question: "Should password validation be enabled?" }],
          },
        },
      ],
    });
    expect(context).toBe("Should password validation be enabled?");
    expect(redactPersistedDrafts(state, () => context).drafts["agent:host:agent"].input.text).toBe(
      "yes",
    );
  });

  it("includes explicit credential requests in question descriptions", () => {
    const state: DraftStoreState = {
      drafts: {
        "agent:host:agent": {
          input: { text: "x", attachments: [] },
          lifecycle: "active",
          updatedAt: 1,
          version: 1,
        },
      },
      createModalDraft: null,
    };
    for (const question of [
      { title: "Login", description: "Enter your password" },
      { question: "Account login", description: "Provide your API key" },
    ]) {
      const context = draftAnswerContext({
        pendingQuestions: [
          {
            id: "question",
            provider: "codex",
            kind: "question",
            name: "question",
            title: "Questions",
            input: { questions: [question] },
          },
        ],
      });
      expect(
        redactPersistedDrafts(state, () => context).drafts["agent:host:agent"].input.text,
      ).toBe(SECRET_ANSWER_NOTICE);
    }
  });
});
