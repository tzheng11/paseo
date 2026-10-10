# Workspace organizer spike

A Studio-owned organization shared by every client connected to Studio. See [the overview](OVERVIEW.md) for the workflow and limits.

Browser captures: [wide layout](screenshots/web-wide.png) and [compact layout](screenshots/web-compact.png).

## Run

From this checkout, build the SDK and typecheck the example:

```sh
npm run build:client
npm run build:plugin
npm run typecheck --workspace=@getpaseo/plugin
```

Use the matching fork client. On the single host that will own the tree, after enabling trusted plugins:

```sh
paseo plugin install /absolute/path/to/paseo/plugin-examples/workspace-organizer
paseo plugin ls
```

Open **Organize workspaces**. Pair the other hosts in this client to discover their workspaces. Do not install this plugin on those hosts: duplicate installations have independent settings, and Paseo selects contributions by the current host.

Plugin reload uses `paseo plugin reload workspace-organizer`; it does not require restarting the main daemon. Deploy the fork's web build separately to get direct sidebar navigation.

## Storage and authority

The installation host's existing plugin settings store is the sole writer. For the default Paseo home the file is:

```text
~/.paseo/plugin-settings/workspace-organizer/organization.json
```

A custom daemon home changes that prefix. Back up this file before uninstalling; Paseo removes installation settings on uninstall. Reload and disable preserve it.

The versioned document contains folders and workspace references identified by `(serverId, workspaceId)`, parent references, sibling order, names and project URLs. Existing daemons continue to own workspace execution. All clients use Studio's settings RPCs over their existing Paseo connection; there is no extra HTTP API, database, election or replication. Studio must be online. The revision checked on every save prevents a stale client from silently replacing another client's changes. This spike has one shared organization for all clients allowed to access the installation host; it does not add per-user permissions.

Links are ordinary HTTPS URLs. No Notion API is called and no Notion tokens are stored. Renames are organization aliases, independent of the original workspace title. Removing a reference promotes its immediate children in order and never archives the underlying workspace. Archived or deleted workspaces can leave stale references; remove those manually. Workspaces created after discovery appear when you refresh. Changes to the set of connected hosts also refresh discovery.

## Scope and follow-up

This tests the shared tree and links without replacing the existing flat sidebar. The next product iteration should decide how to integrate the tree with pins, filtering and archive behavior, then add drag ordering and clearer breadcrumbs for identically named entries. Selecting a different entry discards the current unsaved editor draft. Collapse state is ephemeral. Schema limits are 1,000 entries, 20 nesting levels, and 30 links per entry; large-tree performance has not been benchmarked.

If projects later need memberships, issue workflows, Notion synchronization or multiple independent organizations, move this metadata behind the product's central API. The `(host, workspace)` references and parent relationship can carry forward.

## Verification

```sh
npx vitest run plugin-examples/workspace-organizer --bail=1
npm run test --workspace=@getpaseo/app -- --project unit src/plugins/host-navigation.test.ts src/plugins/host-navigation.test.tsx --bail=1
npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/workspace-organizer.spec.ts --workers=1
npm run typecheck
npm run lint
```

The browser scenario uses two isolated daemons and two independent browser contexts. It exercises cross-host nesting, URL persistence, shared ordering, stale draft protection, reload persistence, remote navigation, compact sidebar closing and offline references. It never changes the live Studio daemon.
