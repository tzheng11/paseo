# Pinned folders

Group workspace references into folders inside **Pinned**, including workspaces on different paired hosts. Folders can contain folders and workspaces; workspaces are leaves. Click a folder to expand or collapse it, and click a workspace to open it on its host. Attach named Notion or other HTTPS project links to either kind of entry.

Install this plugin on one host that all your clients connect to, such as Mac Studio. That host stores the shared tree and sends updates to connected clients. Other hosts supply their existing workspace lists and do not need the plugin. The shared folders become unavailable while their host is offline.

Open **Organize pinned folders** in Pinned or Command Center. Create folders, choose a destination folder, and add existing workspaces. In the web sidebar, drag an entry's grip between rows to reorder it, onto a folder to nest it, or onto **Move to top level** to extract it. Touch clients use a long press on the grip. Moving a folder carries its contents. Self/descendant nesting is rejected. Select an entry in the editor to rename it or edit links; its destination and up/down controls also work without dragging. Concurrent edits produce a conflict with the unsaved draft preserved. Project links open externally and require no Notion credentials.

Removing a folder moves its contents up one level in the same order. Unpinning a workspace removes its reference from this tree. Workspace files, agents, and execution stay on their original hosts.

Paseo's existing regular pins remain below the folders, and the Pinned sorting menu applies to those regular pins. Add an existing workspace through the organizer before dragging its shared reference. Adding a workspace here does not change its regular pin; pinning it both ways shows two references. Collapse state is local to the current view. Uninstalling the plugin deletes its saved tree, so back up its settings file first.

Use the matching fork client for placement inside Pinned and direct workspace navigation. This is a spike; native iOS and Android builds have not been verified.

## Agent tools

The stdio MCP bridge uses the same Studio plugin RPCs and revision checks as the UI. It opens no HTTP port and never writes the settings file directly. Build the portable Node 22 bundle from this checkout:

```sh
node scripts/build-workspace-organizer-mcp.mjs
```

Configure an MCP client with an absolute path to Node and `plugin-examples/workspace-organizer/dist/mcp.mjs`. Set `PASEO_ORGANIZER_HOST` to Studio's pairing URL, or to its explicit `ws://`/`wss://` daemon endpoint when directly reachable. Keep pairing URLs in private configuration. There is no implicit local master. Direct endpoints can also use `PASEO_PASSWORD`.

```json
{
  "mcpServers": {
    "paseo-organizer": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/mcp.mjs"],
      "env": { "PASEO_ORGANIZER_HOST": "<Studio pairing URL>" }
    }
  }
}
```

Tools: `list_pinned_folders`, `create_pinned_folder`, `pin_workspace`, `rename_pinned_entry`, `move_pinned_entry`, `remove_pinned_entry`, `set_pinned_project_link`, and `remove_pinned_project_link`. Every mutation requires the latest `revision` returned by the list tool or a successful mutation. After a conflict, read again and reconsider the move against the current tree. Workspace tools alter references only; removing a folder promotes its children.

The optional host setting `mcp-integration` defaults off. Set `{ "enabled": true, "server": { "type": "stdio", "command": "...", "args": ["..."], "env": { "PASEO_ORGANIZER_HOST": "..." } } }` through its settings RPC to inject the bridge into newly created agents on the organizer host. An existing `paseo-organizer` configuration takes precedence. Existing agents keep their current MCP configuration; active sessions are not restarted. Clients on other hosts can use the same bridge with Studio as their explicit target.
