# Workspace organizer

Group workspaces into a shared tree, including workspaces on different paired hosts. Nest a workspace under a folder or another workspace, change sibling order, and attach named Notion or other HTTPS project links. Organizing an entry changes navigation metadata; its files and agents stay on their original host.

Install this plugin on one host that all your clients connect to, such as Mac Studio. That host stores the tree and sends updates to connected clients. Other hosts supply their existing workspace lists and do not need the plugin. The organization becomes unavailable while its host is offline.

Open **Organize workspaces** in the sidebar or Command Center. Add existing workspaces, select an entry to change its parent or links, then save. Concurrent edits produce a conflict with the unsaved draft preserved. Project links open externally and require no Notion integration credentials.

This spike adds an organized section above Paseo's existing sidebar. It supports up/down ordering; collapse state is local to the current view. It reads workspace names from paired online hosts and saves organization metadata on the installation host. URLs are sent to their destination only when opened. Uninstalling the plugin deletes its saved organization, so back up that file first.

Requires Paseo 0.11.2 or later. Direct workspace navigation from sidebar entries uses the accompanying fork change; older clients open the entry's editor instead.
