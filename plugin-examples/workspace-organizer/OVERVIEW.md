# Pinned folders

Group workspace references into folders inside **Pinned**, including workspaces on different paired hosts. Folders can contain folders and workspaces; workspaces are leaves. Click a folder to expand or collapse it, and click a workspace to open it on its host. Attach named Notion or other HTTPS project links to either kind of entry.

Install this plugin on one host that all your clients connect to, such as Mac Studio. That host stores the shared tree and sends updates to connected clients. Other hosts supply their existing workspace lists and do not need the plugin. The shared folders become unavailable while their host is offline.

Open **Organize pinned folders** in Pinned or Command Center. Create folders, choose a destination folder, and add existing workspaces. Select an entry to rename it, move it to another folder, change sibling order, or edit links, then save. Concurrent edits produce a conflict with the unsaved draft preserved. Project links open externally and require no Notion credentials.

Removing a folder moves its contents up one level in the same order. Unpinning a workspace removes its reference from this tree. Workspace files, agents, and execution stay on their original hosts.

The shared tree uses up/down ordering. Paseo's existing regular pins remain below the folders, and the Pinned sorting menu applies to those regular pins. Adding a workspace here does not change its regular pin; pinning it both ways shows two references. Collapse state is local to the current view. Uninstalling the plugin deletes its saved tree, so back up its settings file first.

Use the matching fork client for placement inside Pinned and direct workspace navigation. This is a spike; native iOS and Android builds have not been verified.
