---
title: Workspaces
description: Understand how Paseo groups working directories, agents, terminals, and browsers into workspaces.
nav: Workspaces
order: 10
category: Workspaces
---

# Workspaces

Paseo is organized around workspaces, not chats.

A workspace is the place where a task happens. It has a working directory and can contain multiple sessions running at the same time. In the app, each session opens as a tab.

## Projects contain workspaces

The sidebar starts with projects. A project can be a git repository, a GitHub project, or any directory on a machine running the Paseo daemon.

Inside each project are workspaces. For example:

```
my-app
├── main
├── authentication
│   ├── fix-login-flow
│   └── review-permissions
└── redesign-settings
```

Each workspace is a separate place to work. You can keep one for your main checkout, create another for a feature, or open a GitHub PR as another workspace.

Use the [CLI project commands](/docs/cli#projects) to register, list, rename, or delete projects.

Drag a workspace onto the middle of another workspace to nest it. Drop near the top or bottom
edge to place it before or after that workspace. Dragging a parent carries its children with it.
On a phone or tablet, hold the grip beside a workspace, then drag. The arrow beside a parent
expands or collapses its children.

Workspaces can be nested within one project on one host. Each workspace keeps its own working
directory, sessions, and isolation. Hierarchy and sibling order are saved by the daemon and shared
between clients; expanded and collapsed branches are saved on each client. Archiving a parent
keeps its children active and makes them visible at the top level.

## Pinned workspaces

Pin a workspace to keep it and its children in the Pinned section above the project list. A child
already included under a pinned ancestor appears once. The menu beside Pinned
chooses **Manual** or **A–Z**. A–Z follows the displayed workspace title (or branch name when that
display option is selected), ignores case, and puts numbered names such as Task 2 before Task 10.
Renaming a workspace updates its position.

A–Z orders pinned roots; children keep their sibling order. Status grouping remains a flat activity list.

The choice is saved on this client. Switching back to Manual restores your saved drag order.
Dragging a pinned workspace selects Manual and saves the new order.
Dragging between Pinned and the project list pins or unpins the workspace to follow the destination.

## Workspaces contain sessions

Agents run inside a workspace as sessions. A workspace can have one agent session, several agent sessions, terminals, browsers, and diffs open at the same time.

That matters because real development rarely fits into one long chat. You might ask one agent to implement a feature, open a terminal to run a service, start another agent to review the diff, and keep the browser open next to both. Those belong together because they are all part of the same task.

In Paseo, the workspace is the stable container. The sessions are what you run inside it.

## Choose the isolation

Every workspace has an isolation mode:

- **Local** uses an existing directory, such as your main checkout. Use it when sessions should share the files already on disk.
- **Worktree** creates or opens a managed git worktree. Use it when a task needs its own directory and branch.

The workspace is the product concept; a git worktree is one way to isolate its files. More than one workspace can refer to the same managed worktree, and Paseo removes that worktree after its last workspace is archived.

## Creating a workspace

For a desktop walkthrough from starting parallel agents to reviewing and testing their changes, see [Run parallel tasks](/docs/parallel-development).

You can create a workspace in the app or from the CLI:

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main
paseo workspace create --isolation worktree --path ~/dev/my-app --base origin/main
```

You can also create a workspace without starting an agent right away. The workspace is still there with its working directory ready; you can open terminals, run services, or browse files, then start an agent later.

Either way, once the workspace exists you can add more sessions to it. Open a terminal alongside an agent, start a second agent to review changes, or open a browser tab to check a local service. Every session lives as a tab inside the same workspace.

Creating an agent and creating a workspace are separate actions. Pass a workspace ID when you want an agent in a specific existing workspace. A bare `paseo run` from a human shell creates a new local workspace; when one agent runs it, Paseo recognizes the caller and creates a subagent in the caller's workspace.

## Worktrees

Every workspace in Paseo is backed by a working directory. When that directory is a git worktree, you get a separate branch and isolated environment for each task.

If you want the details on configuring setup hooks, scripts, and services, continue to [Git worktrees](/docs/worktrees).
