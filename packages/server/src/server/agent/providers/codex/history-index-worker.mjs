import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
/* eslint-disable unicorn/require-post-message-target-origin -- Node MessagePort has no targetOrigin. */

// Query only metadata here. SQLite's native payloads never cross this port.
const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
try {
  db.exec("PRAGMA query_only=ON; PRAGMA cache_size=-4096; BEGIN");
  const thread = workerData.threadId;
  // octet_length(column) reads byte lengths without loading JSON payload pages.
  const stats = db
    .prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(octet_length(item_json)), 0) AS bytes,
    COALESCE(MAX(rollout_ordinal), 0) AS lastOrdinal,
    COALESCE(MAX(updated_at_ordinal), 0) AS lastUpdate
    FROM thread_items WHERE thread_id = ?`)
    .get(thread);
  const count = Number(stats.count);
  const totalBytes = Number(stats.bytes);
  const metadata = `SELECT item_id AS itemId, turn_id AS turnId,
    rollout_ordinal AS ordinal, octet_length(item_json) AS bytes
    FROM thread_items WHERE thread_id = ?`;
  const previous = db.prepare(`SELECT item_id AS id FROM thread_items
    WHERE thread_id = ? AND turn_id = ? AND rollout_ordinal < ?
    ORDER BY rollout_ordinal DESC LIMIT 1`);
  function reference(row, index) {
    return {
      itemId: String(row.itemId),
      turnId: String(row.turnId),
      ordinal: Number(row.ordinal),
      bytes: Number(row.bytes),
      index,
      previousItemId: previous.get(thread, row.turnId, row.ordinal)?.id ?? null,
    };
  }
  function validate(limit) {
    if (
      !Number.isSafeInteger(limit.events) ||
      limit.events < 1 ||
      limit.events > 1000 ||
      !Number.isSafeInteger(limit.bytes) ||
      limit.bytes < 1 ||
      limit.bytes > 8 * 1024 * 1024
    )
      throw new RangeError("History limit is outside the bounded range");
  }
  function select(rows, limit, start, step) {
    validate(limit);
    let bytes = 0;
    const refs = [];
    for (let offset = 0; offset < rows.length; offset++) {
      const row = rows[offset];
      // Reserve space for normalized event/cursor envelopes before decoding.
      const size = Number(row.bytes) + 384;
      if (bytes + size > limit.bytes) break;
      refs.push(reference(row, start + offset * step));
      bytes += size;
    }
    return refs;
  }
  let selection;
  if (workerData.operation === "windows") {
    const { head: headLimit, tail: tailLimit } = workerData;
    validate(headLimit);
    validate(tailLimit);
    const head = select(
      db.prepare(metadata + " ORDER BY rollout_ordinal ASC LIMIT ?").all(thread, headLimit.events),
      headLimit,
      0,
      1,
    );
    const tailRows = db
      .prepare(metadata + " ORDER BY rollout_ordinal DESC LIMIT ?")
      .all(thread, Math.min(tailLimit.events, count - head.length));
    const tail = select(tailRows, tailLimit, count - 1, -1).toReversed();
    const end = tail.length ? tail[0].index : count;
    const selectedBytes = [...head, ...tail].reduce((sum, ref) => sum + ref.bytes, 0);
    selection = {
      head,
      tail,
      gap:
        head.length < end
          ? {
              startIndex: head.length,
              endIndex: end - 1,
              count: end - head.length,
              bytes: totalBytes - selectedBytes,
            }
          : null,
    };
  } else if (workerData.operation === "page") {
    const { cursor, direction, limit } = workerData;
    validate(limit);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > count)
      throw new RangeError("History cursor is outside the snapshot");
    const backwards = direction === "before";
    if (!backwards && direction !== "after") throw new RangeError("Invalid history direction");
    const offset = backwards ? count - cursor : cursor;
    const order = backwards ? "DESC" : "ASC";
    const rows = db
      .prepare(metadata + ` ORDER BY rollout_ordinal ${order} LIMIT ? OFFSET ?`)
      .all(thread, limit.events, offset);
    const refs = [],
      oversized = [];
    let bytes = 0,
      visited = 0;
    for (const row of rows) {
      const index = backwards ? cursor - 1 - visited : cursor + visited;
      const size = Number(row.bytes) + 384;
      if (size <= limit.bytes && bytes + size > limit.bytes) break;
      if (size > limit.bytes) oversized.push({ index, bytes: Number(row.bytes) });
      if (size <= limit.bytes) {
        refs.push(reference(row, index));
        bytes += size;
      }
      visited++;
    }
    if (backwards) {
      refs.reverse();
      oversized.reverse();
    }
    const next = backwards ? cursor - visited : cursor + visited;
    selection = { entries: refs, oversized, nextCursor: next <= 0 || next >= count ? null : next };
  } else throw new RangeError("Unknown history operation");
  const userMessages = db
    .prepare(`SELECT item_id AS messageId, turn_id AS turnId
    FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage'
    ORDER BY rollout_ordinal`)
    .all(thread);
  const retained = new Set(workerData.retainedItemIds ?? []);
  const asyncQuestionIds = retained.size
    ? db
        .prepare(`SELECT item_id AS id FROM thread_items
    WHERE thread_id = ?`)
        .all(thread)
        .filter((row) => retained.has(row.id))
        .map((row) => String(row.id))
    : [];
  db.exec("COMMIT");
  parentPort.postMessage({
    ok: true,
    result: {
      ...selection,
      totalEvents: count,
      totalBytes,
      userMessages,
      asyncQuestionIds,
      version: `${count}:${stats.lastOrdinal}:${stats.lastUpdate}`,
      payloadsDecoded: 0,
    },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, errorName: error.constructor.name });
} finally {
  db.close();
  parentPort.close();
}
