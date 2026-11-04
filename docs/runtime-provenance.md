# Impower runtime identity and recovery boundary

`0.15.0-impower` distinguishes the distribution from stock. It does not identify
one build. The server build generates `impower-build.json` alongside the compiled
server modules, containing the exact source commit/tree, upstream commit,
distribution version, source-dirty flag and lockfile SHA256. `buildId` hashes that
ordered identity payload. The packet manifest must seal this file together with
the actual compiled files, own Node, CLI and web assets. A self-reported commit
alone does not prove the files match it.

`server_info` and `daemon.get_status.response` expose `runtimeBuild`; the CLI
`daemon status --json` preserves it. The fork's host badge shows the distribution,
source and build identifiers, with an explicit modified-source label. An absent
build file is unverified provenance; it is not inferred from a tag,
environment variable or the version string. A malformed or digest-mismatched
file fails startup. Nix/Docker source archives without a `.git` entry deliberately
produce no identity file, removing stale outputs in both compiled trees. They can
build, but do not satisfy production qualification, which requires a clean,
sealed identity.

## Persistent write intent

Before custom daemon bootstrap or a supported persisted-config initialization or
save, this source fsyncs a create-only private `runtime-write-intent.json` under
the same Paseo home. Its schema version is 1, `formatFamily` is
`paseo-impower-015`, and `minimumRecoveryVersion` is `0.15.0-impower`. It records a
stable random `generation`, first-intent time, writer version and the build
identity when available. Later writes retain that first generation. Invalid or
newer markers refuse supported config writes; they are never reset automatically.
The writer fsyncs a private temporary file, publishes it with a create-only hard
link, removes its temporary name and fsyncs the directory. Concurrent first
writers read the complete winner and retain its generation.
Invalid config is rejected before creating an intent. Read-only config inspection
does not create one. Closed maintenance boot does not import or run bootstrap.
The supervisor can still create the intent while initializing a missing config
before the worker reaches maintenance mode; a pre-existing valid config avoids
that initialization write.

This is a **conservative positive boundary**, not an operation-completion receipt.
The marker may survive a failed bootstrap or an uncompleted config save. It does
not prove which work completed, that an old command can be retried, or that a
later binary is compatible. It does not cover arbitrary external file editors,
older/custom writers that lack this contract, stock 0.15 writes, PID locks, logs
or OS file metadata. Its absence never proves that stock 0.15 did not start or write.

A corrupt marker requires explicit recovery while all home writers are stopped.
Retain its exact bytes and relevant operation receipts first. Restore the same
generation from a verified retained marker when available; otherwise record an
explicit generation rotation after inspecting current state, preserving the
damaged file as evidence. Do not delete it to obtain an automatic fresh generation
or use a new generation as proof that older writes did not occur. An interrupted
publication can leave a private `.runtime-write-intent.json.*.tmp`; only its
known stopped owner may retire that leftover. It is not the published marker.

Recovery must bind the actual current home/server, this generation when present,
the qualified current writer and compatible recovery reader, and any configured
canonical authority identity/epoch/revision. Use a proven 0.15-compatible reader
on the **current** data. Neither missing optional 0.15 config fields nor a missing
intent authorizes a downgrade to 0.14. Never restore a pre-switch home snapshot
over writes made after switching.

The source fixture exercises real config saves and canonical-store writes,
followed by fresh same-source readers, preserving pin/superpin data, authority
epoch/revision and the write generation. That is source-level coverage only.
Actual packaged writer/reader qualification and terminal/process recovery remain
required. `minimumRecoveryVersion` is a lower bound, not automatic compatibility
approval for every version above it.
