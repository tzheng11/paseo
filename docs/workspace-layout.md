# Canonical workspace layout

The Impower distribution can use one explicitly configured daemon as the layout
authority. Main-host selection does not elect it. Execution, files, agents,
histories, project names and workspace titles remain on their owning hosts.

## Configuration and trust

`config.json.workspaceLayout` contains `role` (`authority` or `replica`),
`authorityServerId`, `authorityId`, `epoch` and `authorityKeySha256`.
The scoped inheritance contract additionally sets `semanticsVersion: 2` on
the authority and each adopted replica. `authorityKeySha256`
is SHA256 of the **UTF-8 base64 text** `daemonPublicKeyB64`, not of its
decoded bytes. IDs and epoch are explicit deployment inputs. A restart does not
create a new epoch or substitute another authority.

The authority role requires an existing supported bcrypt password verifier in
`daemon.auth.password`. The deployment controller must set and verify password
protection before enabling relay access. The source does not create or
distribute a service password. Use a fresh application-only password, never a
human, provider or SSH credential. Password possession is not a per-replica
identity or allowlist.

Authority mode always requires protected relay admission, even when the legacy
`daemon.relay.requireProtectedSecurity` setting is absent or later disabled.
Offers supplied to replicas must advertise protected mode; configure and verify
the supported setting before creating the authority's registration offer.

Replicas use daemon-owned ConnectedHosts registrations. The registration metadata
contains `role: "layout-authority"`, `expectedServerId`, `authorityKeySha256`,
`authorityId` and `epoch`. The actual relay offer must match the configured
server/key, require protected relay encryption, and carry the service password.
This is checked **before persistence or connection**, and again against the
accepted server identity before a routed layout call. Metadata alone is not a
pin. Plaintext, unpinned and password-free authority routes are refused.

The password-bearing connection stays in private daemon `hosts.json` (mode
0600). Host summaries omit it. Never copy it into a browser catalogue, web
bootstrap, localStorage, source, logs or a public receipt. Web/native clients
call their own daemon; its forwarding keeps the authority credential server-side.

## Offline captured-data inspection

A DOWN recovery reader must not call `WorkspaceLayoutStore.inspect()`: it locks the
home and may complete an initialized-guard write. The pure exports below consume
caller-captured bytes without constructing a store, reading files, locking,
initializing config, creating a write intent, or normalizing persisted records:

- `workspace-layout-store.ts`: `parseCapturedWorkspaceLayout({ serverId, configured,
marker, store, guard, replica })`. The four file captures correspond to
  `workspace-layout-mode.json`, `workspace-layout.json`,
  `workspace-layout-initialized.json`, and `workspace-layout-replica.json`.
  `configured` is the validated config's `workspaceLayout`, or `undefined`.
- `workspace-registry.ts`: `parseCapturedWorkspaceRegistry(capture)` and
  `parseCapturedProjectRegistry(capture)` for `projects/workspaces.json` and
  `projects/projects.json`.
- `persisted-config.ts`: `parseCapturedConfig(capture)` for `config.json`.

A capture is explicitly `{ state: "present", bytes: string | Uint8Array }`,
`{ state: "absent" }`, or `{ state: "unreadable" }`. An unreadable capture refuses;
an absent registry/config remains absent, never an empty array/default config.
UTF-8 byte input must decode strictly. Invalid JSON, duplicate decoded object
keys, invalid schema values, unknown fields that a schema would strip, and
normalization of an explicitly supplied field refuse with static error codes.
Successful registry/config results contain the validated schema **input**, not
its normalized output: omitted legacy fields remain omitted. For example, an
explicit orphan-superpin repair or `daemon.allowedHosts` rewrite is refused,
not silently applied. Supported passthrough config fields remain present.
Config values and results are private and must never be printed in diagnostics.

The layout parser resolves the sticky mode against configured identity/key and
returns a discriminated legacy, uninitialized-authority, initialized-authority,
or replica result. A damaged replica cache deliberately refuses offline inspection even though the
live service can discard it and try to fetch a fresh authority snapshot.
Replica cache absence is explicit; a cached snapshot never
becomes authoritative or fresh and contains no invented commit receipts.
Authority data requires the matching initialized guard. A present store with a
missing/false guard is an incomplete initialization and refuses without repair.
Format 3 requires complete navigation/client provenance, nullable unranked
entries, valid graphs and import identities. The full receipt map must retain
one correctly indexed, identity-bound receipt per committed revision, with a
non-regressing phase history and the final receipt's exact current stamp.
Request payloads are not stored in this file: its parser cannot authenticate a
receipt's request digest against an unavailable original request.

These exports are available in the packet's corresponding
`runtime/packages/server/dist/server/server/*.js` modules. The secondary
`dist/src/server` supervisor closure additionally includes the config parser and
its `captured-json.js` dependency; it does not promise a second copy of the
registry or layout-store exports. They reuse the live schemas and graph validator;
`captured-json.js` is their shared pure decoding dependency. They return typed
validated data or refusal only. They do not authorize recovery, replay,
retirement, a downgrade, or authority freshness. The native caller owns nofollow
and UID/home/server binding, explicit absence, stable byte capture, current
writer/guard/generation checks and any newer-state comparison. Local registry
records are retained as observations; their omitted pin/rank fields are not
canonical unpin/order decisions, and their schema validation is not a separate
cross-file hierarchy or filesystem-closure proof.

## Durable identity and transactions

The authority owns `workspace-layout.json` relative to its qualified Paseo home.
Existing complete-layout mode retains store format 3. Scoped derived inheritance
uses store format 4, snapshot `semanticsVersion: 2`, and a schema-2 sticky home
marker. Earlier readers must refuse these homes rather than strip owner or
section state. Existing initialized format-3 stores are not silently converted;
a separately qualified import/adoption preserves their source and receipts. The version label alone never
qualifies a recovery reader.
`workspace-layout-initialized.json` prevents an initialized but missing store
from being recreated empty. A corrupt store, mismatched identity, stale epoch or
abandoned writer lock requires recovery; none selects a fallback authority.

Entity identity is `(serverId, workspaceId)`. Equal local IDs, paths, repository
URLs and display names on different hosts never merge entities. Each entry holds
ordinary/superpin timestamps, structural parent, structural sibling order,
sidebar placement, archive observation, project membership and entry revision.
Structural `siblingOrder: null` means unranked. Legacy workspace responses omit
that optional rank, preserving their existing numeric-first, then-name ordering
within mixed-host project views. No zero or array-index rank is invented on import.
An explicit move may rank its group while retaining that observed order.
Archived entries and both pin holds remain in snapshots. The structural parent
is host-local; explicit sidebar parents can cross hosts. Both parent graphs
are validated without recursively walking deep trees. A structurally nested pin
whose parent is in another section retains its structural relationship and
appears at the root of its own sidebar section, as before. Explicit sidebar
links also retain their stored parent and order when either workspace is archived
or changes pin section. The visible projection lifts an ineligible child to its
section root; returning both workspaces to the same section reactivates the link.
All dormant links still participate in cycle and missing-reference validation.
Creating a new explicit link requires an active parent in the same section.

`workspace.layout.commit.request` uses an expected authority identity, epoch,
global revision and phase. Entry changes additionally compare the entry revision.
One commit can change multiple entries. It fsyncs the file and directory before
returning a receipt. An identical request ID and payload returns its durable
receipt before checking the now-stale CAS. A reused ID with another payload is
refused. Callers must retain the original request and reconcile an uncertain
outcome; a new request ID is not recovery evidence.

`workspace.layout.receipt.request` / SDK `getWorkspaceLayoutReceipt` reads the
authority's retained receipt by `mutationRequestId`, without replaying the write.
Verify its request ID, normalized request SHA256 and authority stamp against the
original input; `canonicalLayoutJson` supplies the shared digest encoding. A null
result means no receipt was found at that observation. It never proves that an
uncertain operation is safe to retry. Replicas forward this query to the pinned
authority and do not synthesize receipts from their cache.
The store indexes receipts by a digest of the request ID and retains the original
ID in the receipt. This avoids losing IDs such as `__proto__` through JSON object
parsing. Earlier experimental raw-key receipt stores are refused by format.

Native registry intents re-inspect and re-run pure revision/intent guards after a
definite `stale_revision` refusal, using at most three attempts and a distinct ID
for each refused attempt. They never retry a timeout, lost acknowledgement,
entry-revision conflict or another unknown outcome. Raw administrative commits
remain explicit CAS operations; their callers retain and reconcile their request.

A matching durable receipt is checked against the normalized request hash. It
can advance a known complete snapshot without waiting for another read. Failure
of the follow-up read or replica persistence does not relabel that mutation as
failed; it leaves replication stale. Older read responses overtaken during the
request cannot replace a newer snapshot. An actual regression below the revision
known when the read started, or a same-revision fork, still refuses.

Active scoped-inheritance homes support reserve-then-retire through normal archive;
see [Canonical retirement](#canonical-retirement). Complete-layout format-3 homes
retain their original retirement refusal.

## Shared navigation and client sources

The snapshot's `navigation` holds one revisioned preference document:
`workspaceSort` (manual/created/lastPrompt), `projectOrder`, `workspaceOrderByProject`, `workspaceSortModeByProject`,
`pinnedWorkspaceSortMode`, `pinnedWorkspaceOrder` and
`superpinnedWorkspaceOrder`. Workspace keys are host-qualified; equal local IDs
remain distinct. Project view keys are the exact app grouping keys, including
host/project-qualified fallback keys. Import never matches them by display name
or guesses an equivalence from a path. These arrays express order only. They
cannot create or clear ordinary or superpin membership.

`import-client` retains a source ID, original source SHA256, resolution SHA256,
interpreted preferences and dormant historical client tree. Its original bytes
remain in the controller's immutable import evidence. Inactive client trees may
contain obsolete references; retaining that provenance does not activate those
edges or override canonical entry placements.

`put-navigation` compares `expectedRevision` as well as the global CAS. During
import it additionally requires `importResolution.clientSources` to match every
retained client source and records the explicit global `resolutionSha256`.
Activation requires resolved navigation and an exact `requiredClientImports`
manifest. Adding or replacing a client source invalidates a resolution against
the earlier source bytes. Active edits preserve the import provenance and cannot
replace it. Live order references must exist in the full canonical entry set;
archived references and unused view keys remain as dormant preferences.

`decodeLegacySidebarLayout(bytes)` validates retained version 0–3 envelopes
strictly before invoking the app's shared versioned interpretation. Version 0/1
uses the existing scoped-key migration; version 2/3 preserves exact modern keys.
Malformed trees, unknown fields and future versions refuse rather than being
discarded. Its result is source-hashed order data, not a pin observation or an
automatic conflict resolution. Conflicting client preferences require an explicit
preview ruling; neither current host selection nor recency chooses a winner.

The separate `sidebar-view` client key contributes global `workspaceSort` through
`decodeLegacySidebarViewOrdering(bytes)`, using the existing version 0–8 grouping
migration rule. Filters and grouping remain client preferences. Each source key
has its own original hash in `clientImports`; partial preferences are provenance,
and the resolved canonical navigation must explicitly supply the global sort.

The fork client binds its sidebar to the configured authority identity advertised
by its authenticated host connection. Matching replicas are routes to that same
authority; they do not elect a different authority. Conflicting server/key/epoch
declarations refuse edits. The client subscribes to canonical snapshots and routes
all project order, workspace order, pin-section order and sort setters through
the daemon's forwarding API. Automatic local catalogue reconciliation never
publishes an import or fills a shared order with defaults.

The original `sidebar-project-workspace-order` and `sidebar-view` bytes remain
untouched after canonical mode is known. A separate
`canonical-sidebar-layout-replica-v1` observation/journal retains the last view,
identity and original pending request. Client-only filters can still persist in a
separate local preference key; their copy of global sort never becomes a writer.
Hydration cannot replace a canonical observation with those old values. Cached
views survive reload while offline, with editing refused and no offline queue.
Before canonical mode is configured, an ordinary host move retains the client's
saved project order and hidden references. A single host rank update is not an
import of that entire view. Import captures those original bytes under the
layout-writer fence; it never clears them merely because one row moved.

A client persists the normalized request and digest before dispatch. A definite
semantic or proven pre-send refusal requires refresh and a new user intent; an uncertain outcome retains
the original request and blocks further edits. “Check saved change” performs only
receipt/read queries. A matching receipt clears the uncertainty. Alternatively,
a newer same-epoch snapshot read **before** a subsequent absent-receipt read
proves the old CAS can never apply; the intent can be retired without replay.
An absent receipt at the original CAS, transport loss after submission or a
generic persistence failure stays unknown. Layout commits never queue for a
later connection. An acknowledged revision remains the minimum accepted
revision across client reloads. A failed follow-up read keeps the view read-only
without relabelling the acknowledged write as failed.

Canonical drag/drop commits pin membership, explicit placements and shared order
in one transaction. Ordinary project order uses host-qualified keys, so moving
one host's row does not rank other hosts' unranked rows or discard archived order
references. Archived descendants retain dormant edges and are excluded from
active drag membership. Before a client observes canonical mode, legacy hosts
retain their host-local operation. Afterwards, rows missing from the canonical
import refuse shared edits; the client never switches those rows to a local writer.
This does not make an old client's independent local ordering canonical. Actual
client/build/transport and cross-client restart acceptance still require release
verification; stock packaged renderers that lack this client code are not
qualified by daemon feature flags alone.

With `semanticsVersion: 2`, MCP and app moves use a fresh authority read and
one global/entry CAS, with no per-owner writes or rollback. They verify the moved
workspace, its required old ancestry, destination parent chain and explicit
ordering dependencies against online adopted owners. An unknown owner remains
explicitly unknown; a move does not claim its descendant set is empty. A missing
required ancestor names the unresolved key and refuses that component.

Each entry retains raw pin timestamps and immutable `sectionIntent` adoption
baselines: `baselineSection` and `baselineParentWorkspaceKey`. `mode: inherit`
follows the stored parent graph; `explicit` keeps the entry's own section.
Qualified legacy links inherit when their immutable section baselines match.
Originally mismatched links retain their personal section and dormant edge.
Archived parents lift their children until the link becomes eligible again.
Baselines survive later root pin changes, explicit overrides and reparenting.

A reparent to a linked parent changes the moved entry's relation and inherited
intent, leaving raw descendant pins unchanged. When an unknown owner later joins,
its qualified child baselines resolve through the current canonical graph. Thus
raw-unpinned Y→X inherits a superpinned P after X→P without replaying an old parent
or rewriting Y. A root move or pin command records explicit section intent;
detaching preserves the currently effective priority timestamps. A no-op explicit
pin choice still records intent so a later ancestor change cannot override it.

`resolveEffectiveWorkspaceLayout` is shared by daemon and app. Native directory,
MCP and CLI reads publish the effective membership; raw canonical/protection
fields remain separate. App directory caches remain native observations, while
the canonical read projection also updates offline cached descendants whenever
the authority revision changes. Unknown ancestry is represented explicitly, not
as an empty or fresh owner. The CLI's project-local structural move remains a
separate operation and uses the same canonical registry projection.

New format-4 mutations include `writerVersion: 2`; durable matching receipts are
checked before the writer fence. The `workspaceLayoutDerivedSections` capability
and sticky schema-2 marker prevent older clients/daemons from overwriting or
silently stripping the new semantics. Old clients may parse additive wire fields
but cannot submit legacy-shaped writes to the new authority. An uncertain MCP
commit retains its exact original request in the daemon log and reports that
request for receipt reconciliation; it never retries against a newer graph.

Legacy per-owner placement has no complete cross-host descendant authority.
Universal MCP moves name unavailable owners and refuse incomplete coverage until
supported canonical adoption is active. Fresh-leaf creation keeps working.

## Bootstrap and import

The RPCs and SDK methods are:

| RPC                                   | SDK method                                     | Permission       |
| ------------------------------------- | ---------------------------------------------- | ---------------- |
| `workspace.layout.inspect.request`    | `getWorkspaceLayout`, `observeWorkspaceLayout` | `workspace.read` |
| `workspace.layout.initialize.request` | `initializeWorkspaceLayout`                    | `daemon.manage`  |
| `workspace.layout.commit.request`     | `commitWorkspaceLayout`                        | `daemon.manage`  |

Initialize is explicit and creates an **importing** store. An ordinary read never
initializes it. Import commits carry one host's complete entries, the exact source
SHA256 and a resolution SHA256. Replacing a host import must also name its previous
source hash and cannot drop an existing entry. Different source bytes require a
new preview and explicit conflict resolution, not a latest-mtime or union rule.

`pinnedAt` and `superpinnedAt` are required null/timestamp values in import entries.
The pure disk decoder `decodeLegacyWorkspaceLayout` accepts an explicit producer
profile and hashes the original bytes. `upstream-014` requires every row to have
explicit ordinary pin and archive observations and to omit all four unsupported
fork fields. It maps unsupported superpins/parents/placements to null and ranks to
unranked. `impower-layout-v1` requires the rich producer's explicit fields and
preserves finite ranks; an omitted placement means no override. A mixed census,
missing ordinary pin, malformed value or duplicate identity refuses the import.
The profile is a decoding declaration, not proof of source origin or that an
earlier client never discarded data; the controller still binds exact source
provenance and all retained backups. This exception applies only to retained disk
bytes. Missing fields in a fresh RPC observation remain unresolved.

Client
order/layout sources require the same explicit preservation and conflict process.
The deployment import preview must bind those rulings and all original source
bytes; the store does not infer them from a hash supplied by a caller.

Unresolved cross-host parents may be retained while importing. Activation names
the exact complete import manifest, then refuses unknown parents, cycles,
cross-project structural parents. Historical dormant sidebar links remain stored,
without being treated as new cross-section assignments. The
controller must verify that manifest against the entire intended fleet and client
source inventory; the store does not hardcode a host roster.

Scoped adoption declares every intended owner in `ownerDomains` as `adopted`
or `unknown`. `declare-unknown-owner` is an importing-only mutation; it stores no
invented workspace rows. `import-host` atomically records an adopted domain and
its source provenance. Activation binds the exact `requiredOwnerDomains` as well
as host/client manifests. Missing references may remain only when they name a
declared unknown owner; graph and section projection retain that uncertainty.
Import qualification adds immutable raw section/edge baselines using
`qualifyLegacyWorkspaceLayoutEntries`; ambiguous conflict rulings remain the
controller's explicit, source-bound responsibility.

An active unknown owner joins through one `import-host` with its exact
`expectedDomainRevision`, no prior imported source, qualified complete entries
and preserved source/resolution hashes. Admission validates the combined stored
graph, including dormant edges. A discovered cycle refuses the admission and
keeps the owner unknown until conflict reconciliation. It never replaces an
already adopted owner's current entries or reopens importing globally. Before
its legacy writers resume, the joining home must be fenced on the new capability
and its current raw capture reconciled under the existing deployment custody.
No dated backup, last-online timestamp or creation-time estimate establishes that
an unknown owner lacks descendants.

During importing, legacy layout edits and new workspace creation are refused.
Creation checks run before plugin creation hooks, project writes and worktree
provisioning. A connection loss after that check may still leave a partial
creation, whose existing causal receipt must be reconciled rather than replayed.
Existing execution can continue, and unrelated local workspace metadata can be
updated. Thus per-host runtime hops can fence layout writers without requiring
one simultaneous stop of all agents on all machines. Read-only local observations
during this phase are not canonical acceptance.

## Replicas and existing writers

The canonical registry routes pin, superpin, placement, move, workspace
creation and lifecycle updates through the same authority. Derived mode requires
`layoutWriterVersion: 2` on native layout and potential workspace-creation or
restore envelopes, including agent creation/import. The current SDK sends this
only after the host advertises `workspaceLayoutDerivedSections`; older native
callers are refused before dispatch, provisioning or hooks. Generic layout CAS
requires the caller's explicit `writerVersion: 2`, preserving its request digest.
This fences legacy clients as well as old owner daemons; direct edits to raw state
remain outside the supported API. Whole-record
reconciliation preserves canonical layout fields instead of restoring stale
copies. Directory publications project canonical values. A background owned
subscription updates replicas; reconnect obtains a new identity-bound snapshot.

`workspace-layout-replica.json` and pin fields in local `projects/workspaces.json`
are protection/read replicas. They are never writable authorities. An unreachable
authority permits stale reads and refuses layout writes. There is no offline
mutation queue or fallback to local layout persistence. `server_info.workspaceLayout`
reports configuration, last stamp and subscription synchronization; this is not
proof of fleet acceptance or a retirement reservation.

Failed observations retry with bounded exponential backoff while the host link
stays online. Invalid caches are discarded as observations and replaced only
from the pinned authority. A local record absent from an active canonical layout
is retained with its holds, isolated from directory publication, and logged. A
direct read or edit of that record refuses; other imported records remain usable.

New workspace creation commits layout before writing its local execution record.
If the local write then fails, the canonical identity is retained and creation
requires reconciliation. It is not silently deleted or reused.

## Destructive archival

Canonical boot writes the sticky `workspace-layout-mode.json` marker:

```json
{
  "schemaVersion": 2,
  "semanticsVersion": 2,
  "role": "replica",
  "authorityServerId": "<configured server>",
  "authorityId": "<configured UUID>",
  "epoch": "<configured UUID>",
  "authorityKeySha256": "<configured SHA256>",
  "destructiveRetirement": "refuse"
}
```

Removing the config key does not remove this protection. A malformed/unreadable
declaration or marker is a refusal, not evidence of a legacy home. Direct native
archive/remove and unqualified teardown still refuse. Normal archive on an active
scoped-inheritance home uses the reservation path below. Background reconciliation
retains missing canonical workspaces and continues unrelated metadata inspection.
External retirement tools must use the same operation rather than infer permission
from a recent file, explicit null pin, CWD, request ID or a local lock.

## Canonical retirement

The normal workspace archive, whole-worktree archive, MCP archive, callbacks
bound to an exact native workspace ID, and project removal share the owner-side
archive service. The CWD/PR-only auto-merge observer remains unqualified on canonical
homes and refuses; it cannot reinterpret an old observation as a replacement ID.
Caller permissions, caller-directory scope and untrusted-source gates still apply.
Project removal reserves its complete local footprint before stopping resources;
it retains project directories, as before. Quarantined native records participate
in destructive admission even though they are absent from published workspace lists.

The authority accepts three additive mutations with `writerVersion: 3`:

- `reserve-retirement`: an operation UUID, owner server, exact owner-qualified
  target refs and entry revisions, and the owner's opaque backing-generation digest.
  The authority derives and fences the ancestry read set. It refuses importing,
  protected targets, unresolved/foreign ancestry, live descendants outside the
  footprint, stale revisions and overlapping retirements.
- `archive-retirement`: archives the reserved targets in place. The tombstones,
  original refs, layout provenance, imports, navigation and historical receipts remain.
- `complete-retirement`: releases the reservation's temporary dependency fences
  after the owner's teardown obligations finish. Retired IDs cannot be resurrected.

A reservation promotes the authority to format 5, preserving its identity, epoch,
revision history and prior receipt map. The retiring owner promotes its existing
sticky marker to schema 3 without changing the binding. Format-4 writers remain
accepted before the first reservation; afterwards writer 3 is required. Inspect
and observation requests advertise `retirementVersion: 1`; older authority readers
are refused once reservation state exists. `workspaceLayoutRetirement` advertises
the implementation. Upgrade the authority first, then all adopted writers before
using retirement. Do not roll back an owner with a schema-3 marker or a format-5
authority. Older binaries cannot enforce this state and must fail closed.

An unrelated unknown owner is retained and does not veto a proven eligible leaf.
An affected missing owner or ancestry refuses. A later owner import that introduces
an edge to a reserved or retired target also refuses; unknown data is not treated
as an empty domain or silently reparented after retirement.

`workspace-retirements/` under the owning home contains durable effect journals.
Each binds authority identity, operation, checked CAS inputs, native IDs/creation
times, backing paths and the backing/shared-reference generation. Authority receipts
are reconciled by the original request and hash after a lost acknowledgement.
Reservation is durable before setup, agent or terminal teardown. Native archival
and the canonical tombstones use the same journaled timestamp. Canonical archive
is committed and receipt-checked after native archival and before path hooks or
irreversible directory deletion. Each effect records intent before execution and
completion afterwards, and rechecks fresh authority ownership, native identity,
holds and backing/shared references. Only the private, currently executing owner
context can consume that reservation. A context inherited by a delayed async
callback expires when the operation returns.

Normal native backing transitions acquire canonicalized overlapping-path and
native identity read-set leases. Disjoint updates and creation continue during a
paused retirement. Nested acquisitions must be covered or acquire a vacant scope
extension; a conflicting expansion refuses rather than waiting with a partial
lease. Provider imports preflight the backing fence and hold their lease through
the complete import callback, with fresh admission after acquisition. Completed
operations return their recorded result on replay. A retained directory can later
be registered as a new native ID; old-ID callbacks cannot select that replacement.
Whole-worktree list responses additionally carry an opaque `backingGeneration`;
the CLI returns it automatically as `expectedBackingGeneration`. A stale or missing
generation on a canonical path archive refuses before effects.

Project removal also persists an owner-side `project-retirements/` request journal
before native teardown. It binds the authority/epoch, owner, original project
incarnation, exact native IDs and backing generation. Retries reconcile that saved
footprint and its authority receipt; they never select a replacement workspace.
New active members or a different project incarnation refuse metadata removal.
If removal persisted but its notification failed, original-project absence resolves
the operation without repeating removal or icon cleanup. A completed request returns
its original outcome without touching a later project or slot generation.

An interrupted or uncertain effect remains journaled and fenced, without a TTL.
Status reads and ordinary archive replay never start recovery. An owner on a host
advertising `features.workspaceRetirementRecovery` can explicitly run
`paseo workspace retirement-recover <operation-id> --json`, or call
`DaemonClient.recoverWorkspaceRetirement(operationId)`. This requires
`workspace.manage` and reuses the original operation, target footprint and authority
receipt; it never selects a workspace by path or newest receipt.

Recovery refuses while the original owner is running, or while non-path effects
are unresolved. A durable failed result records that the original awaited producer
returned. A crash with no such closure evidence instead requires the owner to
confirm that the previous producer has ended, using `--effects-closed` together
with `--backing-generation <digest-from-retirement-status>`. This is an explicit,
operation-bound owner assertion, not a timeout heuristic or an automatic retry.
The daemon refuses a missing/mismatched generation and records the assertion.
Without closure evidence, it retains the existing fence rather than allowing an
old cleanup process to affect a reused backing. After verified native archival it holds the original backing and
identity leases, rechecks native generations, holds and the archive receipt, then
settles the remaining directory obligation. An already-absent directory needs no
second removal. For a still-present backing, a saved inode observation must match
before retrying the existing ownership/shared-reference/source checks and
non-forcing Git removal. The retry keeps the 120-second Git bound. If removal
cannot finish, the same operation completes with `removedDirectory:false`,
`slotKept:true` and `directoryLeftBehind.reason`, releasing its dependency fence.
That receipt does not claim bytes reclaimed.

An uncertain teardown hook is never replayed. Its directory is retained. Version-1
journals without the saved backing observation also finish conservatively with
`recovery_backing_identity_unverified`; they cannot authorize deletion of a later
backing generation. Recovery resolutions are durable alongside the original step
history, so interruption of completion can reconcile the same authority receipt
without another teardown or deletion. Old native identities remain tombstoned;
a completed old operation cannot select a replacement workspace at the same path.
The capability is required before sending a recovery request to an older owner.
No configuration, import or activation change is involved.

A definite, receipt-checked reservation refusal with no effects is terminal and
retained in journal history before a later fresh admission. Unrelated canonical
branches remain writable while a reservation is outstanding. A create blocked by
a retirement reports its operation UUID and owner-qualified target, retaining the
`retirement_conflict` code; it does not imply the create had no other effects.

Directory removal requires owned backing, no remaining native references and a
clean source checkout whose HEAD is proven landed in the main checkout's HEAD or
its configured remote default branch. The alternate proof reads only the local
symbolic `refs/remotes/<remote>/HEAD`: select the attached main branch's upstream
remote, or the sole remote. A personal branch's upstream is not a merged base.
No fetch runs; missing, ambiguous or invalid refs preserve source. Detached main
checkouts retain the main-HEAD-only behavior. These
checks run before hooks and again before removal. The final Git removal is
non-forcing: it cannot fall through to recursive deletion or broad prune. A source
change, unknown proof or shared reference retains the directory. Results separate
record archival, `removedDirectory`, `slotKept`, `directoryLeftBehind` and the
retirement operation's complete/partial state; they do not claim reclaimed bytes.

External routines must not detach dependencies or stop shared resources before
native reservation, nor repeat path cleanup after a completed operation. Their
independent resource journal must be adapted to the owner operation and backing
lifetime, or delegate that cleanup to the synchronous daemon teardown path.
An environment flag, standalone shell invocation or cached receipt is not a
reservation consumer. The Impower retirement routine's external dependency/resource
adapter is a separate integration change; deploying this fork alone does not
qualify that routine.

## Recovery limits

The [runtime provenance and write-intent contract](runtime-provenance.md) records
the conservative custom 0.15 write boundary. The canonical store retains its
separate identity/epoch/revision; a host intent is not an authority transaction.

Keep the same current homes and authority store across runtime recovery. Do not
restore an older home snapshot over writes made after switching. A source unit
test, old 0.14 proof, version label or missing new optional config field does not
qualify a 0.15 recovery reader. Runtime/terminal compatibility, installed Desktop
behavior, exact artifact identity and current operation/work custody remain
separate release requirements.

### Caller-owned retirement IDs and synchronous consumer cleanup

Canonical exact-workspace archive accepts an optional caller-preallocated UUID:
`paseo workspace archive <id> --operation-id <uuid> --json`, SDK
`archiveWorkspace(id, {operationId, requestId?})`, and MCP
`archive_workspace({workspaceId, operationId})`. The UUID identifies the durable
operation; `requestId` only correlates a transport response. Persist the UUID before
calling. A timeout means read that operation on the same owner host, never select by
CWD/name/newest and never rerun cleanup. The SDK requires the additive
`workspaceRetirementOperations` capability before sending an explicit ID. Ordinary
no-ID archive and legacy homes retain their existing behavior; explicit IDs have no
legacy fallback.

`workspace retirement-status <uuid> --json` and SDK
`getWorkspaceRetirementStatus(uuid)` only read evidence. Unknown IDs return
`not-found`/`null`. The projection reports `pending`, terminal `refused`, `partial`
or `complete`, a typed code, the backing generation and the recorded archive result
(including receipt, directory removal, kept slot and preservation reason). It never
repairs a journal, reconciles a write or starts an operation. Early holds are durable
before effects; a refused ID cannot become a fresh attempt after its hold clears.
Backing contention waits before durable admission with the original UUID; status
may still be `not-found` while that call is queued. Unknown is not proof that the
request was never sent. An already-pending same-ID archive response uses
`retirement.state: partial` with `retirement_in_progress` (MCP also sets `isError`);
read status to distinguish pending from a finished partial teardown. No effects
are retried by that response.

A dynamic read-set expansion that still cannot be admitted returns the terminal
refusal code `retirement_admission_contended`, not a workspace hold. Recheck
eligibility and retry with a **new UUID** after that known transient refusal.
Use a new UUID for a newly admitted request. Reuse with a different workspace
conflicts. Incomplete evidence remains partial; lookup is not recovery authority.
MCP exposes the equivalent scope-checked `get_workspace_retirement_status` tool.

A canonical synchronous `worktree.teardown` receives
`PASEO_RETIREMENT_OPERATION_ID`, `PASEO_RETIREMENT_BACKING_GENERATION`,
`PASEO_RETIREMENT_WORKSPACE_ID`, `PASEO_RETIREMENT_WORKTREE_PATH` and
`PASEO_RETIREMENT_TEARDOWN_CWD`. It also receives `PASEO_HOME` set to the
absolute owning daemon home, overriding an inherited home, and clears inherited
`PASEO_HOST`. Use explicit
`--home "$PASEO_HOME"` for verification so ambient endpoint settings cannot select
another daemon. No-ID hooks on non-layout homes keep their inherited home.
The generation includes canonical backing paths,
filesystem identity, native creation identities and shared references. Inherited
values cannot manufacture this binding. Before dependency/service cleanup, the hook
uses normal existing authorization to call `workspace retirement-verify <uuid>`
with `--workspace-id`, `--backing-generation`, `--worktree-path` and
`--teardown-cwd` from those fields (SDK `verifyWorkspaceRetirementBinding`). A false
verification exits nonzero. Status needs `workspace.read`; verification uses the
archive `workspace.manage` or `hub.execute` permission.

Verification requires the exact currently awaited hook, its live backing fence,
started effect step and fresh authority/native/shared-reference checks. It takes no
second backing lease, which would deadlock the hook. A durable receipt or started
journal does not authorize cleanup after hook exit, failure, daemon restart or slot
reuse. Keep cleanup synchronous: a successful verification is not a reusable permit
for a detached callback. No credential, connection or layout configuration change
is part of this interface.

Install the new daemon packet and matching CLI on each target host before its
consumer starts sending explicit IDs there. During a mixed fleet, hosts without
`workspaceRetirementOperations` remain unavailable for this consumer; the SDK and
CLI report `WORKSPACE_RETIREMENT_UNSUPPORTED` before sending, not a hold or an
uncertain archive. Upgrade the layout authority first and finish every adopted
writer before permitting retirement; this source provides no automatic fleet-wide
build census. The six-host installation is supervised separately.

Unknown-ID fallback reads only generation-named journals and the exact historical
UUID. A foreign non-journal filename, or a parsed record explicitly carrying
another operation ID, does not poison that lookup. Matching or indexed corruption,
and an undecodable generation-named file whose ID cannot be determined, remain a
typed `retirement_lookup_integrity_failed`/binding failure. Lookup never repairs or
deletes that evidence; destructive admission retains its existing strict fences.
