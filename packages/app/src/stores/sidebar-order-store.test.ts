import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSidebarOrderUpdates,
  type SidebarProjectEntry,
} from "@/hooks/sidebar-workspaces-view-model";
import { migrateSidebarOrderState, useSidebarOrderStore } from "./sidebar-order-store";

describe("migrateSidebarOrderState", () => {
  it("prefixes legacy per-server workspace order with the source server id", () => {
    const migrated = migrateSidebarOrderState({
      projectOrderByServerId: {
        "host-a": ["project-a"],
        "host-b": ["project-a"],
      },
      workspaceOrderByServerAndProject: {
        "host-a::project-a": ["main", "feature"],
        "host-b::project-a": ["main"],
      },
    });

    expect(migrated).toEqual({
      projectOrder: ["project-a"],
      pinnedWorkspaceOrder: [],
      superpinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: {},
      pinnedWorkspaceSortMode: "manual",
      workspaceSortModeByProject: {},
      workspaceOrderByProject: {
        "project-a": ["host-a:main", "host-a:feature", "host-b:main"],
      },
    });
  });

  it("preserves superpin manual order across validated storage, migration, and hydration", async () => {
    const options = useSidebarOrderStore.persist.getOptions();
    if (!options.storage) throw new Error("Missing sidebar storage");
    const storageName = options.name;
    if (!storageName) throw new Error("Missing sidebar storage name");
    useSidebarOrderStore.getState().setSuperpinnedWorkspaceOrder(["host:b", "host:a", "host:b"]);
    const saved = await options.storage.getItem(storageName);
    expect(saved?.state).toMatchObject({
      superpinnedWorkspaceOrder: ["host:b", "host:a"],
    });
    expect(migrateSidebarOrderState(saved?.state).superpinnedWorkspaceOrder).toEqual([
      "host:b",
      "host:a",
    ]);
    useSidebarOrderStore.setState({ superpinnedWorkspaceOrder: [] });
    if (!saved) throw new Error("Sidebar state was not persisted");
    await options.storage.setItem(storageName, saved);
    await useSidebarOrderStore.persist.rehydrate();
    expect(useSidebarOrderStore.getState().superpinnedWorkspaceOrder).toEqual(["host:b", "host:a"]);
    expect(migrateSidebarOrderState(null)).toEqual({
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      superpinnedWorkspaceOrder: [],
      pinnedWorkspaceTree: {},
      pinnedWorkspaceSortMode: "manual",
      workspaceOrderByProject: {},
      workspaceSortModeByProject: {},
    });
  });

  it("normalizes pinned workspace order", () => {
    const migrated = migrateSidebarOrderState({
      pinnedWorkspaceOrder: [" host-a:one ", "host-a:one", "", "host-b:two"],
    });

    expect(migrated.pinnedWorkspaceOrder).toEqual(["host-a:one", "host-b:two"]);
  });

  it.each([0, 1])("retains legacy trimming and per-server merges for version %i", (version) => {
    const migrated = migrateSidebarOrderState(
      {
        projectOrder: [" project ", "project"],
        projectOrderByServerId: { "host-a": [" other ", "project"] },
        pinnedWorkspaceOrder: [" host-a:one ", "host-a:one"],
        superpinnedWorkspaceOrder: [" host-a:two ", "host-a:two"],
        workspaceOrderByProject: {
          " project ": [" host-a:one ", "host-a:one"],
        },
        workspaceOrderByServerAndProject: {
          " host-a :: project ": [" one ", " two ", "host-a:two"],
        },
      },
      version,
    );

    expect(migrated).toMatchObject({
      projectOrder: ["project", "other"],
      pinnedWorkspaceOrder: ["host-a:one"],
      superpinnedWorkspaceOrder: ["host-a:two"],
      workspaceOrderByProject: { project: ["host-a:one", "host-a:two"] },
      pinnedWorkspaceTree: {},
    });
  });

  it("round-trips host-qualified parents, fractional ranks and dormant entries through actual validated persistence", async () => {
    const tree = {
      "one:shared": { parentWorkspaceKey: "two:shared", siblingOrder: 0.125 },
      "offline:child": {
        parentWorkspaceKey: "offline:parent",
        siblingOrder: -2.5,
      },
    };
    await useSidebarOrderStore.getState().setPinnedWorkspaceTree(tree);
    const options = useSidebarOrderStore.persist.getOptions();
    const name = options.name;
    if (!name) throw new Error("Missing sidebar storage name");
    const saved = await options.storage!.getItem(name);
    expect(saved?.version).toBe(3);
    expect(saved?.state).toMatchObject({ pinnedWorkspaceTree: tree });
    await useSidebarOrderStore.setState({ pinnedWorkspaceTree: {} });
    await options.storage!.setItem(name, saved!);
    await useSidebarOrderStore.persist.rehydrate();
    expect(useSidebarOrderStore.getState().pinnedWorkspaceTree).toEqual(tree);
  });

  it("hydrates a real v2 envelope without dropping its existing orders", async () => {
    const options = useSidebarOrderStore.persist.getOptions();
    const name = options.name;
    if (!name) throw new Error("Missing sidebar storage name");
    await AsyncStorage.setItem(
      name,
      JSON.stringify({
        version: 2,
        state: {
          pinnedWorkspaceOrder: ["one:a", "two:b"],
          superpinnedWorkspaceOrder: ["three:c"],
          workspaceOrderByProject: { project: ["one:a"] },
        },
      }),
    );
    await useSidebarOrderStore.persist.rehydrate();
    expect(useSidebarOrderStore.getState()).toMatchObject({
      pinnedWorkspaceTree: {},
      pinnedWorkspaceOrder: ["one:a", "two:b"],
      superpinnedWorkspaceOrder: ["three:c"],
      workspaceOrderByProject: { project: ["one:a"] },
    });
    expect(JSON.parse((await AsyncStorage.getItem(name))!).version).toBe(3);
  });

  it("awaits the durable tree write and rejects a storage failure", async () => {
    let release!: () => void;
    const spy = vi.spyOn(AsyncStorage, "setItem").mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      let complete = false;
      const pending = useSidebarOrderStore
        .getState()
        .setPinnedWorkspaceTree(
          {
            "one:a": { parentWorkspaceKey: null, siblingOrder: 0 },
          },
          { section: "pinned", keys: ["one:a"] },
        )
        .then(() => {
          complete = true;
          return undefined;
        });
      await Promise.resolve();
      expect(complete).toBe(false);
      release();
      await pending;
      expect(complete).toBe(true);
      spy.mockRejectedValueOnce(new Error("Storage unavailable"));
      await expect(
        useSidebarOrderStore
          .getState()
          .setPinnedWorkspaceTree({}, { section: "superpinned", keys: ["two:b"] }),
      ).rejects.toThrow("Storage unavailable");
    } finally {
      spy.mockRestore();
    }
  });

  it("writes tree, deduplicated root order and manual sort atomically through validated storage", async () => {
    await useSidebarOrderStore.setState({
      pinnedWorkspaceSortMode: "alphabetical",
      superpinnedWorkspaceOrder: ["priority:a"],
    });
    const options = useSidebarOrderStore.persist.getOptions();
    const name = options.name;
    if (!name) throw new Error("Missing sidebar storage name");
    const spy = vi.spyOn(AsyncStorage, "setItem");
    try {
      const tree = {
        "one:a": { parentWorkspaceKey: "two:b", siblingOrder: 0.125 },
      };
      await useSidebarOrderStore.getState().setPinnedWorkspaceTree(tree, {
        section: "pinned",
        keys: ["two:b", "two:b", "one:a"],
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const saved = JSON.parse((await AsyncStorage.getItem(name))!);
      expect(saved.state).toMatchObject({
        pinnedWorkspaceTree: tree,
        pinnedWorkspaceOrder: ["two:b", "one:a"],
        pinnedWorkspaceSortMode: "manual",
        superpinnedWorkspaceOrder: ["priority:a"],
      });
      expect(JSON.parse(spy.mock.calls[0]![1])).toEqual(saved);
      useSidebarOrderStore.getState().setPinnedWorkspaceSortMode("activity");
      spy.mockClear();
      await useSidebarOrderStore.getState().setPinnedWorkspaceTree(tree, {
        section: "superpinned",
        keys: ["priority:b", "priority:b"],
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(useSidebarOrderStore.getState()).toMatchObject({
        superpinnedWorkspaceOrder: ["priority:b"],
        pinnedWorkspaceSortMode: "activity",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects invalid ranks without losing unrelated legacy orders", () => {
    expect(
      migrateSidebarOrderState({
        pinnedWorkspaceOrder: ["one:a"],
        pinnedWorkspaceTree: {
          "one:a": {
            parentWorkspaceKey: null,
            siblingOrder: Number.POSITIVE_INFINITY,
          },
        },
      }),
    ).toMatchObject({
      pinnedWorkspaceOrder: ["one:a"],
      pinnedWorkspaceTree: {},
    });
  });

  it("preserves alphabetical sorting and manual order during migration", () => {
    expect(
      migrateSidebarOrderState({
        pinnedWorkspaceSortMode: "alphabetical",
        pinnedWorkspaceOrder: ["b", "a"],
      }),
    ).toMatchObject({
      pinnedWorkspaceSortMode: "alphabetical",
      pinnedWorkspaceOrder: ["b", "a"],
    });
  });

  it("restores the saved manual order after toggling sort modes", () => {
    const store = useSidebarOrderStore.getState();
    store.setPinnedWorkspaceOrder(["b", "a"]);
    store.setPinnedWorkspaceSortMode("alphabetical");
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual(["b", "a"]);
    store.setPinnedWorkspaceSortMode("manual");
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual(["b", "a"]);
  });

  it("returns to manual sorting when pinned workspaces are dragged", () => {
    const store = useSidebarOrderStore.getState();
    store.setPinnedWorkspaceSortMode("alphabetical");
    store.setPinnedWorkspaceOrder(["c", "a", "b"]);
    expect(useSidebarOrderStore.getState().pinnedWorkspaceSortMode).toBe("manual");
    expect(useSidebarOrderStore.getState().pinnedWorkspaceOrder).toEqual(["c", "a", "b"]);
  });

  it("persists project sort modes independently of pinned sort and saved manual order", () => {
    const migrated = migrateSidebarOrderState({
      workspaceOrderByProject: { first: ["b", "a"], second: ["d", "c"] },
      workspaceSortModeByProject: { first: "alphabetical", second: "activity" },
      pinnedWorkspaceSortMode: "activity",
    });
    expect(migrated).toMatchObject({
      workspaceOrderByProject: { first: ["b", "a"], second: ["d", "c"] },
      workspaceSortModeByProject: { first: "alphabetical", second: "activity" },
      pinnedWorkspaceSortMode: "activity",
    });
  });

  it("keeps each project's mode and manual order while selecting another mode", () => {
    useSidebarOrderStore.setState({
      workspaceOrderByProject: {},
      workspaceSortModeByProject: {},
    });
    const store = useSidebarOrderStore.getState();
    store.setWorkspaceOrder("first", ["b", "a"]);
    store.setWorkspaceSortMode("first", "alphabetical");
    store.setWorkspaceSortMode("second", "activity");
    store.setWorkspaceSortMode("first", "manual");
    expect(useSidebarOrderStore.getState().workspaceSortModeByProject).toEqual({
      first: "manual",
      second: "activity",
    });
    expect(store.getWorkspaceOrder("first")).toEqual(["b", "a"]);
  });

  it("preserves an automatic sort when reconciliation appends a new workspace", () => {
    const store = useSidebarOrderStore.getState();
    store.setWorkspaceSortMode("reconciled", "activity");
    store.setWorkspaceOrder("reconciled", ["old", "new"]);
    expect(useSidebarOrderStore.getState().workspaceSortModeByProject.reconciled).toBe("activity");
  });
});

// A directory whose name ends in a space produces a view key that ends in a
// space. Trimming it on write used to make the sidebar's reconcile effect loop
// forever, crashing the app with React error #185 (see #4880).
describe("sidebar order keys that end in whitespace", () => {
  const PROJECT_KEY = "host:srv-1:/home/u/Reklamation ";

  beforeEach(() => {
    useSidebarOrderStore.setState({
      projectOrder: [],
      pinnedWorkspaceOrder: [],
      workspaceOrderByProject: {},
      workspaceSortModeByProject: {},
    });
  });

  it("stores a project key exactly as given", () => {
    useSidebarOrderStore.getState().setProjectOrder([PROJECT_KEY]);

    expect(useSidebarOrderStore.getState().projectOrder).toEqual([PROJECT_KEY]);
  });

  it("scopes a workspace order under the project key the sidebar indexes by", () => {
    useSidebarOrderStore.getState().setWorkspaceOrder(PROJECT_KEY, ["srv-1:main"]);

    // use-sidebar-workspaces-list reads workspaceOrderByProject by view key
    // directly, so the scope has to be stored under that same key.
    expect(useSidebarOrderStore.getState().workspaceOrderByProject[PROJECT_KEY]).toEqual([
      "srv-1:main",
    ]);
    expect(useSidebarOrderStore.getState().getWorkspaceOrder(PROJECT_KEY)).toEqual(["srv-1:main"]);
    useSidebarOrderStore.getState().setWorkspaceSortMode(PROJECT_KEY, "activity");
    expect(useSidebarOrderStore.getState().workspaceSortModeByProject[PROJECT_KEY]).toBe(
      "activity",
    );
  });

  it("settles the sidebar order reconcile instead of rewriting it forever", () => {
    const projects: SidebarProjectEntry[] = [
      {
        viewKey: PROJECT_KEY,
        projectName: "Reklamation ",
        projectKind: "non_git",
        iconWorkingDir: "/home/u/Reklamation ",
        hosts: [],
        workspaces: [],
      },
    ];
    const runPass = () =>
      computeSidebarOrderUpdates({
        projects,
        persistedProjectOrder: useSidebarOrderStore.getState().projectOrder,
        getWorkspaceOrder: (key) => useSidebarOrderStore.getState().getWorkspaceOrder(key),
      });

    // First pass adds the newly visible project.
    const first = runPass();
    expect(first.projectOrder).toEqual([PROJECT_KEY]);
    useSidebarOrderStore.getState().setProjectOrder(first.projectOrder ?? []);

    // Second pass must find nothing left to do; otherwise the effect that
    // applies these updates re-runs on every render.
    expect(runPass().projectOrder).toBeNull();
  });

  it("still trims keys when migrating persisted state", () => {
    const migrated = migrateSidebarOrderState({
      projectOrder: [" host-a:one ", "host-a:one"],
    });

    expect(migrated.projectOrder).toEqual(["host-a:one"]);
  });

  it("preserves exact v2 scope and order keys through validated hydration and v3 persistence", async () => {
    const options = useSidebarOrderStore.persist.getOptions();
    const name = options.name;
    if (!name) throw new Error("Missing sidebar storage name");
    const siblingProjectKey = PROJECT_KEY.trimEnd();
    const state = {
      projectOrder: [PROJECT_KEY, siblingProjectKey],
      pinnedWorkspaceOrder: ["srv-1:feature ", "srv-1:feature"],
      superpinnedWorkspaceOrder: ["srv-2:priority ", "srv-2:priority"],
      pinnedWorkspaceSortMode: "activity",
      workspaceOrderByProject: {
        [PROJECT_KEY]: ["srv-1:spaced ", "srv-1:spaced"],
        [siblingProjectKey]: ["srv-1:plain"],
      },
      workspaceSortModeByProject: {
        [PROJECT_KEY]: "activity",
        [siblingProjectKey]: "alphabetical",
      },
    };
    await AsyncStorage.setItem(name, JSON.stringify({ version: 2, state }));

    await useSidebarOrderStore.persist.rehydrate();

    const expectedState = { ...state, pinnedWorkspaceTree: {} };
    expect(useSidebarOrderStore.getState()).toMatchObject(expectedState);
    expect(useSidebarOrderStore.getState().getWorkspaceOrder(PROJECT_KEY)).toEqual(
      state.workspaceOrderByProject[PROJECT_KEY],
    );
    expect(useSidebarOrderStore.getState().getWorkspaceOrder(siblingProjectKey)).toEqual([
      "srv-1:plain",
    ]);
    expect(JSON.parse((await AsyncStorage.getItem(name))!)).toEqual({
      version: 3,
      state: expectedState,
    });

    await useSidebarOrderStore.persist.rehydrate();
    expect(useSidebarOrderStore.getState()).toMatchObject(expectedState);
  });
});
