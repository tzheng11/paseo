import { runReclaimCommand, runReclaimStatusCommand, runReclaimVerifyCommand } from "./reclaim.js";
import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import {
  runArchiveCommand,
  runRetirementStatusCommand,
  runRetirementVerifyCommand,
} from "./archive.js";
import { runCreateCommand } from "./create.js";
import { runLsCommand } from "./ls.js";
import { runMoveCommand } from "./move.js";
import { runRenameCommand } from "./rename.js";
import { runSetupCommand } from "./setup.js";

export function createWorkspaceCommand(): Command {
  const workspace = new Command("workspace").description("Manage workspaces");

  addJsonAndDaemonHostOptions(
    workspace
      .command("setup")
      .description("Allow and run setup for a workspace")
      .argument("<workspace-id>", "Workspace id"),
  ).action(withOutput(runSetupCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("create")
      .description("Create a workspace")
      .requiredOption("--isolation <local|worktree>", "Workspace isolation")
      .option("--path <path>", "Local directory or source checkout (default: current)")
      .option("--project <id>", "Existing project id")
      .option("--title <title>", "Workspace title")
      .option("--parent <id>", "Parent workspace id")
      .option("--sibling-order <number>", "Workspace order among siblings")
      .option(
        "--mode <mode>",
        "Worktree mode: branch-off, checkout-branch, or checkout-pr (default: branch-off)",
      )
      .option("--worktree-slug <slug>", "Managed worktree path slug")
      .option("--new-branch <name>", "New branch name (--mode branch-off)")
      .option("--base <ref>", "Base ref (--mode branch-off)")
      .option("--branch <name>", "Existing branch (--mode checkout-branch)")
      .option("--pr-number <n>", "Pull request or change request number (--mode checkout-pr)")
      .option("--forge <forge>", "Forge for --mode checkout-pr (default: source checkout)")
      .option("--background", "Create a background workspace")
      .option("--no-background", "Create a visible workspace instead of inheriting background"),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("ls")
      .description("List active workspaces")
      .option("--background", "Include background workspaces"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("rename")
      .description("Set a workspace's user-visible title")
      .argument("<workspace-id>", "Workspace id")
      .argument("[title]", "New workspace title")
      .option("--reset", "Clear the title and revert to the branch or directory name")
      // Commander 12 accepts excess positionals by default, which would rename to
      // the first word of an unquoted multi-word title and silently drop the rest.
      .allowExcessArguments(false),
  ).action(withOutput(runRenameCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("move")
      .description("Move a workspace under a parent or to the project root")
      .argument("<workspace-id>", "Workspace id")
      .option("--parent <id>", "Destination parent workspace id")
      .option("--root", "Move to the project root")
      .option("--before <id>", "Place before a workspace in the destination")
      .allowExcessArguments(false),
  ).action(withOutput(runMoveCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("archive")
      .description("Archive a workspace and everything it owns")
      .argument("<workspace-id>", "Workspace id")
      .option("--operation-id <uuid>", "Caller-preallocated canonical retirement operation id"),
  ).action(withOutput(runArchiveCommand));

  addJsonAndDaemonHostOptions(
    workspace
      .command("retirement-status")
      .description("Read a retirement operation without starting or retrying it")
      .argument("<operation-id>", "Retirement operation UUID"),
  ).action(withOutput(runRetirementStatusCommand));
  addJsonAndDaemonHostOptions(
    workspace
      .command("retirement-verify")
      .description("Verify a currently running synchronous retirement hook binding")
      .argument("<operation-id>", "Retirement operation UUID")
      .requiredOption("--workspace-id <id>", "Original workspace id")
      .requiredOption("--backing-generation <sha256>", "Backing/path generation")
      .requiredOption("--worktree-path <path>", "Exact worktree path")
      .requiredOption("--teardown-cwd <path>", "Exact teardown cwd"),
  ).action(withOutput(runRetirementVerifyCommand));
  addJsonAndDaemonHostOptions(
    workspace
      .command("reclaim")
      .description("Preview or apply exact managed backing reclaim; never archives an identity")
      .argument("<path>")
      .requiredOption("--release-evidence <sha256>", "Opaque released-owner evidence digest")
      .option("--workspace-id <id>")
      .option("--original-operation-id <uuid>")
      .option("--original-backing-generation <sha256>")
      .option("--apply")
      .option("--operation-id <uuid>")
      .option("--expected-generation <sha256>"),
  ).action(withOutput(runReclaimCommand));
  addJsonAndDaemonHostOptions(
    workspace.command("reclaim-status").argument("<operation-id>"),
  ).action(withOutput(runReclaimStatusCommand));
  addJsonAndDaemonHostOptions(
    workspace
      .command("reclaim-verify")
      .description(
        "Qualify the live synchronous reclaim guard after owner release and external-reference checks",
      )
      .argument("<operation-id>")
      .requiredOption("--expected-generation <sha256>")
      .requiredOption("--path <path>")
      .requiredOption("--release-evidence <sha256>")
      .option("--owner-released")
      .option("--external-references-clear"),
  ).action(withOutput(runReclaimVerifyCommand));
  return workspace;
}
