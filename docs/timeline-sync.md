# Timeline sync

Agent chat delivery has two paths:

1. **Live stream** — `agent_stream` WebSocket messages for immediacy. These may be delta-shaped lifecycle updates.
2. **Authoritative history** — `fetch_agent_timeline_request` for correctness. This always returns full projected timeline items, never lifecycle deltas.

The daemon keeps projected items in a disposable SQLite cache under
`$PASEO_HOME/runtime/timeline-cache/`. A 32 MiB serialized-row cache is shared across all loaded
agents; SQLite's page cache has a 4 MiB target. Provider history remains the durable transcript
authority and rebuilds the projection when an agent resumes. You can remove abandoned caches
while the daemon is stopped. Normal shutdown removes its cache; startup removes caches owned
by processes that have exited.

The disposable cache keeps its transaction rollback journal in memory. Live session operations
share a processing budget of at most 32 starts or 4 ms before yielding to the event loop; each
agent still processes its events in order. Async provider work does not hold the shared budget.
This prevents a burst of live updates from starving health requests and relay heartbeats.

Each source event advances the stream sequence, then replaces the previous tool state or merges
into the current text item. Intermediate payloads are never retained for history or catch-up.
History imports stage events on disk before changing the readable timeline, then commit batches
of at most 64 events and 512 KiB. A shared replay write queue yields before each batch, so many
tabs reopening together cannot each consume a full write budget in the same event-loop turn.
A single larger item is processed alone. Replay uses the same per-agent queue
as live events, so new events wait behind the complete import while other agents and connections
remain responsive. History requests wait for that queue until the agent's history is primed.
A failed provider stream leaves the previous timeline readable. Deferred publication
replays the staged file instead of retaining another full timeline array.

Ordinary pages decode selected disk rows in slices of at most 32 rows or 4 ms, yielding between
slices. An old tool anchor can expand a nominally small tail across older rows to preserve cursor
coverage; that expansion must use the same cooperative reader. Reads share the agent's live-event
queue so a page cannot mix versions while it yields. Epoch-only operations never decode history.
These limits bound uninterrupted decoding work, not the size of an explicit complete-projection
response or the duration of one SQLite operation.

Codex reloads retain a bounded start and recent
suffix: at most 64 events / 256 KiB at the head and 256 events / 2 MiB at the tail. Both limits
apply independently. A notice separates these ranges for clients without middle-page support.

On Codex 0.159.2+, local paginated history uses the native SQLite projection as a metadata index.
The reader respects the provider's separate `CODEX_SQLITE_HOME`, asks it to index missing history
through a metadata-only turn page, and selects item identifiers and UTF-8 sizes in a worker.
Only selected items pass through the provider decoder. Fetch adjacent selected items in bounded
small batches; never cross a turn, omitted range or oversized record to fill a batch. Native item
anchors preserve cursor positions without requesting every intervening page. The same loader serves refresh, resume,
archived reads and imports; it does not build a complete normalized replay before these reads.

`agent.timeline.history.request` returns head/tail windows or a middle page. The omitted range
reports its source count and bytes. Its `unit` distinguishes native provider items from normalized
replay events; these counts are not projected UI-row counts. A page skips an oversized source
record, reports its size and advances. Selected items remain bounded by serialized bytes and event
count after normalization. Cold bounded reads use a separate read-only provider connection;
resuming a writer can load its entire transcript or start an autonomous goal even when its
response excludes turns. The read requires a paginated native index and fails explicitly when
that contract is unavailable. Ordinary compatible history access and `streamAllHistory` retain
their existing replay paths. An unarchived agent starts its writer only for a later interactive
action, preserving its selected model and speed tier; archived reads stay read-only. Page and
export failures cannot close an existing writer channel.

Provider positions are separate from live-stream cursors. The client gates middle paging on
`server_info.features.boundedTimelineHistory` and the agent's `supportsBoundedHistory` capability,
then renders its start, requested middle pages, gap and recent work. Live items keep their delivery
cursors and replace matching history identities. CLI logs and attach read a bounded tail; logs
report an omitted middle and `--history-cursor` reads its next bounded page.

Legacy Codex threads stage normalized parent/child replay files, keeping routing and rewind
identifiers in memory. Their ordinary replay also selects bounded edges; building those indexes
still traverses provider pages. Older binaries and other adapters can retain large provider-owned
buffers. The projection row-cache budget does not cover explicit `limit: 0` responses.
Turn-end hooks carry bounded projection edges, `timelineGap`, and `providerHistoryGap` when
provider history is unloaded; they do not clone the complete timeline. Search and prompt indexing
explicitly stream provider messages when the client supports middle pages. The native Codex index
selects message references before decoding, so tool output is never transferred just to discard it.
Prompt outlines select only user messages; search includes assistant messages. Preserve positions
in the complete provider history even when skipping items. Finish the metadata snapshot before
provider decoding so a long stream does not pin a SQLite reader transaction. Results carry a
provider index for loading their bounded window; that index never becomes a live stream cursor.
Clients without middle-page support search their readable projection.
Disk-projection prompt outlines use the user-row metadata index before reading payloads;
building an outline must not page tool output or assistant responses into the daemon's main thread.

Full-history consumers have distinct contracts:

| Caller                                            | History contract                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex provider replay/export (`streamAllHistory`) | Explicit eight-item provider pages on a separate read-only connection; no aggregate timeline array.                                                             |
| Search / prompt outline                           | Explicit message stream with provider positions; retains only bounded matches or prompt previews.                                                               |
| Turn-end hooks                                    | Bounded edges with both projection and provider gap metadata. Plugins can request ordinary middle pages through the timeline SDK.                               |
| Fork-context attachment                           | Explicit stream to the chosen message, retaining at most 100,000 characters / 2,000 summary entries. Native provider positions stay separate from live cursors. |
| Import / native fork / archived read / refresh    | Ordinary bounded provider replay. Native rewind uses user-message identifiers, and modern forks exclude turn payloads.                                          |
| CLI logs / attach                                 | Bounded tail and explicit bounded middle pages; oversized records are reported rather than silently dropped.                                                    |
| SDK `timeline.refetch` / catch-up                 | Readable projection pages. `limit: 0` is an explicit complete projection request, not a provider-transcript export.                                             |

Legacy Codex and other provider adapters still need native window support to remove their
provider-owned full response buffers. This Codex native candidate does not establish that bound
for those adapters.

Codex and JSONL RPC transports bound each stdout frame to 64 MiB before decoding. An oversized
frame closes that provider process and rejects pending requests. Provider transcripts stay intact.
The cache requires Node 22.13 or later, or Electron's bundled Node with `node:sqlite` support.

Runtime metrics count projected rows on disk; `timelineStats.totalItems` is not a count of resident
JavaScript objects. Metadata events do not load timelines for hooks. Slow refresh logs include
`agentId`, `requestId`, `historyEventsRead`, `historyBytesRead` and `historyReplayCount`. Those sizes
count normalized UTF-8 replay bytes once, excluding raw provider buffers and repeated spool reads.
A request waiting on another caller's load can report zero. Transcript content is never logged.

The invariants are:

> A continuously subscribed client applies every committed row in order. Opening or resuming an
> agent establishes the daemon's current tail in one bounded request, with older history reachable
> through backward pagination.

Tool output is bounded before it enters either delivery path. Canonical shell tool output is sliced
to 64 KiB. Plain-text content and string values nested in unknown structured tool inputs/results
have the same display limit with a truncation notice. The same bounded item is used for runtime
timeline rows and live stream events; native provider transcripts and permission requests are unchanged.
Provider history hydration applies the same rule so reopening an agent cannot restore an oversized
tool payload.

## Presence is not delivery

Client heartbeat reports presence:

- device type
- app visibility
- focused agent
- last activity time

Heartbeat is used for notification routing. It must not be used as a correctness gate for `agent_stream` delivery. A stale mobile focus heartbeat may affect whether the user gets notified; it must not make timeline rows disappear from the live stream.

## Gap recovery is paged but complete

Large unbounded timeline responses can exceed relay frame limits, so catch-up uses bounded pages. Bounded does not mean partial.

Page limits are projected-item targets. A tool call lifecycle is one projected item even if it spans many source sequence numbers, and assistant/reasoning chunks are merged before counting. The response carries `seqStart`, `seqEnd`, `sourceSeqRanges`, and `collapsed` so clients can advance sequence cursors without rendering delta rows.

When live delivery detects a sequence gap, the app fetches `direction: "after"`. If the daemon
responds with `hasNewer: true`, the app immediately fetches the next page from `endCursor`. Gap
recovery is complete only when `hasNewer: false`.

Initialization timeouts guard lack of catch-up progress, not the full multi-page sync. A successful page that queues the next `after` page refreshes the watchdog.

Opening or resuming an agent fetches one bounded latest tail page. Older history remains
user-driven by scrolling upward.

A failed catch-up or subscription reconcile retries on its own, doubling from 1s to a 30s ceiling.
A fixed 1s retry turned a persistent daemon-side refusal — a Codex thread that already has an active
writer, say — into a request and a log line every second on an idle app. The delay resets on success,
reconnect, delivery-mode change, and visibility change, so recovery is still immediate once the
condition clears. Republishing the same visibility set is a no-op and never bypasses backoff.

Background retries are silent. The retry the user presses in the sync-error callout is a fallible
user action and owns its pending state: `retrying` is a status the sync model publishes, not a React
boolean, so the button reports in-flight and the callout returns to `error` when the attempt fails.

Reaching the history-start threshold loads one older page and preserves the visible content anchor.
Cursor progress does not trigger another page. The user must leave and return to the threshold unless
the anchored page still leaves the viewport at history start, as with short or compacted content; in
that case pagination continues as one loading operation until the page fills the viewport or history
is exhausted.

## Durable item anchors

Provider message IDs are not guaranteed for every displayed item. Paseo-generated system errors are one example. Rendered item indices are not durable either because pagination and projection can merge source rows.

Actions that address a point in chat history, such as Fork, use the daemon timeline `epoch` plus the projected item's `seqEnd`. The app carries that position on the rendered assistant item for both live and fetched history. When adjacent projected chunks merge, the merged item retains the newer chunk's position.

The daemon validates the epoch and locates the projected item at the selected position. A fork
includes projected items through that checkpoint. If an item spans the checkpoint and changed
afterward, the daemon refuses that fork with an actionable error: discarded historical payloads
cannot be reconstructed from sequence metadata. Forking the current context remains available.

## Resume behavior

Opening, reconnecting, and returning from app background establish the current timeline through
bounded catch-up. Switching between continuously subscribed open chats needs no fetch.
Focus alone does not mutate timeline state; the response is compared with the local
authoritative range first.

Cached history remains readable during recovery. The chat shows Reconnecting to host while the host is
offline, then Updating messages until authoritative catch-up completes. Socket connectivity alone cannot
certify that the displayed conversation is current. The timeline owner publishes freshness; the
view renders it without a toast timer or a separate resume workflow.

The draft-create handoff has the same lifetime: the viewed-timeline owner releases it when the sync
stops owing that chat a catch-up, not when the first authoritative page lands. Releasing it at the
first page leaves a chat this client just created looking hydrated but still catching up, which
shows Updating messages for a conversation that cannot be out of date. Closing the tab ends the
obligation too, so a reopened chat starts from authoritative state instead of a stale optimistic
one; disconnect and backgrounding keep it.

Foregrounding probes a nominally connected session immediately. A healthy response preserves the
socket; a failed three-second probe starts reconnecting without waiting for the background heartbeat
or retry backoff. This cannot keep a mobile socket alive after the operating system suspends it.

- The same epoch and `window.maxSeq` is an exact display no-op. The app advances synchronization
  bookkeeping without replacing timeline arrays, preserving an upward-scrolled viewport.
- When the page overlaps or is adjacent to the local end cursor, only projected items newer than
  that cursor are applied. Already-covered rows are not replayed.
- A true middle gap, epoch change, or rewind atomically replaces stale canonical history with the
  latest tail. The replacement reconciles positioned live rows beyond its coverage and unresolved
  local submissions; it never retains two discontiguous canonical ranges.

The installed tail carries `hasOlder`, so history skipped by a replacement remains reachable through
ordinary backward pagination. A backward page is accepted only when it is adjacent to the current
history start; a response requested from a pre-replacement range is stale and is discarded.

A plan approval keeps the original proposal's tool-call identity through resolution and provider
history replay. The pending approval UI can hide that tool from presentation, but the client model
must retain its position. Creating a new history card on rejection places it after the prompt that
rejected it; changing steer-event ordering would also put new assistant output before that prompt.

## Provider child history

Child transcripts use the same projected-page reconciliation as the main conversation. The client
retains rendered items and sequence cursors, never a second cache of source events. Pagination
uses the projected display anchor; live updates advance the source cursor without moving tools.

Child-list recovery follows mounted parent and child panes. Releasing the last consumer stops
future reconnect reads without deleting cached descriptors or transcripts. Reconnect snapshots
share four request slots per client and host; replacing or aborting a snapshot discards its queued
work and stale responses. Already-started shared server loads finish normally, so this admission
limit does not bound the number of provider replays still running after client timeouts.

Clients advertising `projected_subagent_timeline` receive child streams and projected fetches.
Updated clients require `features.projectedSubagentTimeline` for child history; older hosts show
an update-host notice for that pane.
Older clients retain child names/status and receive an upgrade message when opening a child
conversation. This gate affects only the child transcript; it does not gate the connection,
main conversation, or current-context forks. A legacy `canonical` root request still receives
projected items.

## Client replica lifetime

The session projection remains host-scoped for as long as the host is registered. The viewed-timeline
owner wraps cached preparation, network catch-up, accepted timeline application, and persistence
behind one interface. React supplies transport and projection operations without selecting a cache
path or issuing a separate persistence notification.

Active-agent list reconciliation does not own transcript lifetime. An archived agent's fresh
history response can arrive before the active-list response that omits it. Clearing history there
would discard accepted rows while the viewed owner still considers them synchronized. Entity
deletion clears the transcript; list membership changes do not.

Removing the host from the registry is the destructive boundary: it stops the runtime and clears the
session and host-scoped setup state together.

The timeline owner asks durable replica storage for an agent when that agent becomes visible. An
accepted row paints immediately before subscription acknowledgement or timeline fetch. The stored
range describes those exact items: `startSeq` drives older pagination and `endSeq` drives forward
catch-up. The owner requests `after endSeq`, and requests `before startSeq` when the user loads older
history. Code outside the owner does not distinguish cached and network timelines.

The first resume request is bounded. If it reports more newer history, fetch one latest bounded tail
instead of replaying every missed page. Live gap recovery still pages forward until current.

If the canonical window exceeds the cache item limit, contains a discontiguous retained range, has a
live head, or includes presentation data the cache cannot encode losslessly, persistence drops the
range and keeps a display-only tail. Never slice items while retaining the pre-slice range; that
falsely certifies discarded source rows. A display-only row paints without granting synchronization
authority, so the owner uses the ordinary bounded `tail` bootstrap.

Live rows received between cache paint and catch-up stay in the separate live head and reconcile with
the authoritative range through the existing forward-page path. The cache does not persist sync
generation or unreconciled local submissions.

Every daemon-derived live item carries its timeline epoch and sequence position. Bootstrap
replacement keeps only positioned rows newer than the page it installs, while unresolved local
user presentations identify themselves by having client identity without a timeline position. This
prevents a page from duplicating rows it already covers without coupling display continuity to the
shorter-lived submission registry. Unreconciled local presentations are not persisted in the durable
replica cache.

## Selective and legacy delivery

The app chooses one delivery policy from `server_info.features.selectiveAgentTimeline`:

- Selective daemons receive the chats this session has opened, plus any visible agent pane. A chat
  enters that set the first time the user opens it and leaves when its tab closes or the session
  ends, independently of mounted or retained React views: switching workspaces, evicting a retained
  view, app backgrounding, and reconnect all preserve the demand. There is no recent-agent limit.
  Restored workspace layout is a release signal, never a source. It carries a tab for every chat the
  user has ever opened on the host, and a catch-up fetch resumes its agent on the daemon, so
  subscribing from layout spawns a provider session per historical tab at every launch and stamps
  every one of those workspaces as just used (see
  [agent lifecycle](agent-lifecycle.md#workspace-activity)). Visible chats get the first catch-up
  attempt; the rest follow when those attempts settle, including failures, so a failed visible chat
  does not starve background recovery. Split panes catch up together. Hidden chats update the
  replica; on web their retained presentation stays suspended until revealed, on native it keeps
  rendering. Revealing a chat reads the current store and preserves its local UI state.
- Legacy daemons keep globally streaming agent timelines. Visibility still triggers the existing
  authoritative catch-up, but the app does not issue selective-subscription RPCs.

This policy is owned by `viewed-timeline-sync.ts`; downstream reducers do not branch on daemon
version.

## Projected pages reconcile with live presentation

A projected page is canonical state, not a sequence of live deltas. One projected item can overlap
rows already received live—for example, a tool call retained at its original display position while
its completion advances `seqEnd`, followed by a merged assistant message. The app uses
`sourceSeqRanges` to replace overlapping assistant and reasoning projections before applying the
remaining page through the existing stream reducer. It must not append full projected text to a
live prefix.

Every path that sends a message to an agent — composer send, dictation accept-and-send, queued
send-now, and the host runtime's automatic queue drain — goes through
`dispatchComposerAgentMessage` with a submission writer. There is no second transport for the same
product action: calling `client.sendAgentMessage` directly skips the submitted row and the pending
footer, and permanently drops attachments because the daemon does not echo them back.

A submitted prompt is one `UserMessageItem` row. That row is the authoritative local presentation:
its stable identity, text, timestamp, images, and attachments do not change when the provider
acknowledges it. Submission lifecycle is a separate record keyed by agent, not another row shape.
The transaction registry records two independent settlement facts: canonical acknowledgement and RPC
settlement. Canonical acknowledgement retires optimistic activity immediately. When both facts are
known, whichever arrives second deletes the record. A canonical acknowledgement that arrives first
prevents a later transport error from rolling back a prompt already observed.

The daemon's accepted response waits for the correlated run start and guarantees that the canonical
submitted row has been recorded. It publishes the accepted turn's liveness before that row, so the
client applies authoritative activity before canonical acknowledgement retires optimistic activity.
Timeline render batching does not delay lifecycle application. Directory status never settles a
submission. Overlapping sends settle independently rather than collapsing to one newest pending
message.

Daemons advertising `server_info.features.canonicalSubmittedPrompts` guarantee that every accepted
human prompt carrying a client message id is recorded and streamed as a canonical `user_message` with that
same id. This includes daemon-handled commands that do not allocate a foreground turn; their submitted
row is recorded before handler output. The app tracks submission transactions only for hosts with this
capability. Older hosts keep the shipped untracked optimistic-row behavior and roll that row back on RPC
rejection.

Turn activity has one client-side replica. Lifecycle events can attach `turnId`, and agent snapshots can
expose `activeTurn: { turnId, startedAt } | null`. An identified terminal cannot close a different
identified turn; an unnamed legacy terminal can close the current turn. Snapshots, stream events,
cancellation requests, and every visible surface update the same per-agent record. The snapshot covers
both user-started foreground turns and autonomous provider turns;
foreground control ownership remains a separate daemon concern. Cancellation request identity is stored
with that record rather than in a React component, so an old request cannot clear a newer one. Submissions
remain a separate pre-turn registry and retire on canonical acknowledgement.

Canonical turns and visible responses are different boundaries. Agent-originated prompts and lifecycle
notifications project into tool rows, so they do not create a human-message boundary. Legacy system
prompts, including schedule injections, remain hidden. One visible response can span several canonical
turns; layout and copy group that response together while lifecycle, timing, tool sequences, and exact
fork positions retain the canonical `turnId` boundaries.

Agent-message XML belongs to the daemon's `agent/agent-messages` boundary. Prompt delivery encodes
provenance; acceptance, provider echoes, import, and replay share its projection. The delivery ID is
also the projected call ID, so a provider echo cannot create a second row. Sender IDs are opaque and
do not imply local ownership or authorization. Capture the sender title at delivery: archived or
removed senders must remain understandable without a live directory lookup.

The optional `agentMessage` payload carries event, sender, and delivered text. Shared client
presentation (`protocol/paseo-tool-presentation`) owns its heading and expanded details, next to the
labels for every Paseo MCP tool. The daemon
must not construct UI labels or prepend sender labels to the semantic message body. The existing
`tool_call` / `plain_text` envelope is a compatibility adapter: older clients still parse the row and
expand its body. New clients use the typed payload, never infer the event from a tool name or parse
XML. Stream reduction and disk-cache serialization preserve the payload without rendering it.

The compatibility boundary for older daemons is snapshot normalization: running/idle status becomes an
anonymous active turn or idle state once, and downstream code consumes the same activity shape. The app
does not combine anonymous lifecycle events, timestamps, timeline rows, and resume coverage to infer a
second running state. Disconnect preserves the last replicated turn until cache or network hydration
advances it; replica removal remains the destructive close boundary. Elapsed time comes only from turn
liveness, never from submission records or whichever timeline rows happen to be mounted.

For human prompts, the daemon records one canonical submitted user row at acceptance. Its wire `messageId` is the
submission's `clientMessageId`, so the row is born with its final identity and remains immutable on
the wire. A correlated provider echo records the provider's native identity internally without
dispatching another timeline event. Rewind resolves the wire identity to that provider identity at
the provider boundary. Daemon-handled prompts follow the same identity rule.

Content matching is limited to the dated compatibility path for daemon timelines created before
that field existed. Canonical ingestion may match only an explicit unreconciled local candidate;
the draft-create handoff is the one boundary that also permits the legacy canonical twin to have
arrived first. Generic reducers and consumers do not reimplement message identity matching.

Ordinary bootstrap, same-epoch reset, and catch-up replacement preserve unmatched locally submitted
rows because a provider may never echo them. A known epoch change or rewind replaces history and
drops acknowledged local rows omitted by the new canonical epoch; every transaction not yet
acknowledged by the provider, and no other local row, crosses that destructive boundary. A cold
reset without an existing epoch is destructive because the client has no continuity anchor.

Tail rows are positioned history, so an unmatched local presentation is appended after the
canonical replacement rather than ordered by timestamps from different machines. The head is a
live overlay: cursorless items stay there during continuity replacement until canonical positions
arrive, while a destructive replacement retains only active submission transactions.

Canonical replacement owns both timeline lanes. A matching local row keeps its presentation ID and
payload while taking the canonical row's ordered position. If a live assistant head is the
canonical assistant prefix, it stays in the head lane. No row may be returned in both lanes.

## Relevant code

- Server live stream forwarding: `packages/server/src/server/session.ts`
- App sync planning: `packages/app/src/timeline/timeline-sync-plan.ts`
- App viewed-agent synchronization: `packages/app/src/timeline/viewed-timeline-sync.ts`
- App stream/timeline reducer: `packages/app/src/timeline/session-stream-reducers.ts`
- Session wiring: `packages/app/src/contexts/session-context.tsx`
