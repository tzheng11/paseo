# Main host

Main is the default host for a fresh browser and unchosen project/workspace forms. Explicit
routes, saved workspaces, last active projects and picker choices retain priority. Next remains
the independent capacity recommendation. Unset, loading, disagreement and held changes never
manufacture a Main badge or Dots readiness.

The general setting lives in `$PASEO_HOME/fleet.json`, outside the strict daemon config and
stored browser host schemas. Older daemons ignore this file. Reverting the feature leaves the
file intact; reinstalling the feature reads its previous setting and request receipts.

Main initializes once at daemon boot, after the supervisor owns this home. A transaction lock
left by the previous worker is abandoned even when the OS reuses its PID. Live transactions
still refuse competing writers with `fleet_busy`.

A Main initialization failure disables only Main for that daemon run (`features.mainHost=false`)
and logs the cause; agents, terminals and other RPCs remain available. If the allocator key is
missing after this host has allocated, restore `fleet.json` and `fleet-allocator-key.pem` from
the same backup, then restart to retry. Do not delete the setting or generate a replacement key:
existing receipts and receiver pins depend on the original key.

`fleet.main_host.set.request` accepts only `mainHost`, `expectedGeneration` and `requestId`.
The server serializes file transactions, returns a previous request result before comparing
generation, then allocates current + 1. It stamps the receiving host, authenticated principal,
session, declared client kind and time. All allocations start held. A lost reply is retried with
the same request ID; a new ID is a new decision. Generations stop at 2,147,483,647.

The allocator signs the immutable allocation with a separate Ed25519 key, stored with mode
0600 in `fleet-allocator-key.pem`. Receipt format v1 is the fixed ordered JSON array in
`serializeMainHostAllocation`. The receipt excludes receiver-local held/confirmation state.
Changing the allocation, previous host, undo link, time or provenance invalidates its signature.

`fleet.main_host.apply.request` delivers an existing allocation under a local generation CAS.
An owner app fetches the allocator public key through its authenticated host connection and
supplies it to the receiver. Only an owner-app Manage session may establish the first pin for
an allocator server ID. The receiver verifies the receipt before atomically committing the pin,
choice, confirmation and request result. A different pinned key refuses `allocator_unverified`;
a CLI/agent cannot establish or replace a pin. Daemons hold no peer catalogue.

The app catches its selected allocator up before making another choice. Equal-generation
different allocations have no automatic winner; Tim chooses explicitly. Deliver preserves the
allocation and its original provenance. Undo calls set for the previous host with a new request
and generation (including a return to unset after the first choice). Retry resumes that same Undo
receipt after a lost reply or interrupted delivery; a competing choice still refuses Undo. Reconnect may deliver an
already-confirmed newer allocation; it never confirms a held CLI change automatically.
If an acknowledgement is lost, matching confirmed readback clears the app's transport error for
that operation. Held, conflicting or unrelated receipts and named refusals keep the error visible.

Set and apply require `daemon.manage`; read requires `daemon.read`. Client and daemon capability
gates refuse unsupported clients before mutation. Once a Dots database exists, its owner must
inject the store's `hasDotsDatabase` guard: general set/apply refuse `move_required`; the later
Move workflow owns database authority changes.

App vs CLI is declared connection metadata under today's owner authentication. Agents running
as the owner can reach owner credentials and impersonate an owner app. The held rule and receipts
provide attribution and explicit confirmation in normal sessions; they do not isolate code running
as that same Unix user. This is the architecture's accepted owner-access residual.

`paseo fleet main get` reads the receiving daemon. `paseo fleet main set --main-host <server-id>
--expected-generation <n> --request-id <id>` changes only that daemon and remains held for Tim's
Deliver or Undo in the app. No Dots database or provider operation is started by these commands.
