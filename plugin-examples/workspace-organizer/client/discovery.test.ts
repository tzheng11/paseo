import { describe, expect, it, vi } from "vitest";
import { listAllWorkspaces, type Workspace, type WorkspaceList } from "./discovery";

const workspace = (id: string) => ({ id }) as Workspace;
describe("workspace discovery", () => {
  it("loads every page and deduplicates workspaces by host-local ID", async () => {
    const list = vi
      .fn<WorkspaceList>()
      .mockResolvedValueOnce({
        entries: [workspace("a")],
        requestId: "test",
        pageInfo: { prevCursor: null, hasMore: true, nextCursor: "next" },
      })
      .mockResolvedValueOnce({
        entries: [workspace("a"), workspace("b")],
        requestId: "test",
        pageInfo: { prevCursor: null, hasMore: false, nextCursor: null },
      });
    expect(
      (await listAllWorkspaces(list, new AbortController().signal)).map((entry) => entry.id),
    ).toEqual(["a", "b"]);
    expect(list.mock.calls[1][0]).toEqual({ page: { limit: 200, cursor: "next" } });
  });
  it.each([null, "same"])("rejects missing or repeated cursors (%s)", async (nextCursor) => {
    const list = vi.fn<WorkspaceList>().mockResolvedValue({
      entries: [],
      requestId: "test",
      pageInfo: { prevCursor: null, hasMore: true, nextCursor },
    });
    await expect(listAllWorkspaces(list, new AbortController().signal)).rejects.toThrow(
      "invalid workspace cursor",
    );
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it("stops requesting pages after cancellation", async () => {
    const lifetime = new AbortController();
    const list = vi.fn<WorkspaceList>().mockImplementation(async () => {
      lifetime.abort();
      return {
        entries: [],
        requestId: "test",
        pageInfo: { prevCursor: null, hasMore: true, nextCursor: "next" },
      };
    });
    await expect(listAllWorkspaces(list, lifetime.signal)).rejects.toThrow("cancelled");
    expect(list).toHaveBeenCalledTimes(1);
  });
});
