# Canonical workspace layout

The Impower distribution can use one explicitly configured daemon as the layout
authority. Main-host selection does not elect it. Execution, files, agents,
histories, project names and workspace titles remain on their owning hosts.

## Configuration and trust

`config.json.workspaceLayout` contains `role` (`authority` or `replica`),
`authorityServerId`, `authorityId`, `epoch` and `authorityKeySha256`. The last
field is SHA256 of the **UTF-8 base64 text** `daemonPublicKeyB64`, not of its
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

## Durable identity and transactions

The authority owns `workspace-layout.json` relative to its qualified Paseo home.
The store format is version 3; earlier experimental 0.15 readers must refuse it,
not strip shared-view fields during recovery. The version label alone never
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

No delete/retirement mutation is exposed in this initial contract.

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

During importing, legacy layout edits and new workspace creation are refused.
Creation checks run before plugin creation hooks, project writes and worktree
provisioning. A connection loss after that check may still leave a partial
creation, whose existing causal receipt must be reconciled rather than replayed.
Existing execution can continue, and unrelated local workspace metadata can be
updated. Thus per-host runtime hops can fence layout writers without requiring
one simultaneous stop of all agents on all machines. Read-only local observations
during this phase are not canonical acceptance.

## Replicas and existing writers

The canonical registry routes legacy pin, superpin, placement, move, workspace
creation and lifecycle updates through the same authority. Whole-record
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
  "schemaVersion": 1,
  "role": "replica",
  "authorityServerId": "<configured server>",
  "authorityId": "<configured UUID>",
  "epoch": "<configured UUID>",
  "authorityKeySha256": "<configured SHA256>",
  "destructiveRetirement": "refuse"
}
```

Removing the config key does not remove this protection. Core workspace archive
refuses before any teardown when the config declares `workspaceLayout` or the
marker exists. A malformed/unreadable declaration or marker is a refusal, not
evidence of a legacy home. Project removal follows the same refusal before it
stops agents or terminals. Background reconciliation retains missing canonical
workspaces and continues unrelated metadata inspection. External retirement tools
must apply the same rule.

This deliberately blocks destructive retirement until an authority reservation
and its consuming filesystem operation are implemented. A recent file, explicit
null pin or property-presence check cannot substitute for that reservation: another
client can pin the workspace after a read. Archive never gets to decide that a
stale protection copy is authoritative.

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
