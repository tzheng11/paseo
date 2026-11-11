/**
 * The shared repository `config` grows one `[branch "<name>"]` section per pushed or tracked
 * branch, so it is rewritten whenever any worktree sets an upstream. Comparing it section by
 * section tells which workspaces a write can affect instead of treating every write as a
 * change to every checkout.
 */
export interface GitConfigSectionChange {
  /** Names of `[branch "<name>"]` sections that were added, removed or edited. */
  branches: Set<string>;
  /** Any `[remote ...]` section changed. Remote URLs and push defaults feed every snapshot. */
  remotes: boolean;
  /** Any other section changed, including core, status and include settings. */
  other: boolean;
}

export function parseGitConfigSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let key = "";
  for (const line of text.split(/\r?\n/)) {
    // Blank lines carry no setting; skipping them keeps an appended section from
    // looking like an edit to the one before it.
    if (!line.trim()) {
      continue;
    }
    if (/^\s*\[/.test(line)) {
      key = gitConfigSectionKey(line);
    }
    sections.set(key, `${sections.get(key) ?? ""}${line}\n`);
  }
  return sections;
}

export function diffGitConfigSections(
  previous: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): GitConfigSectionChange {
  const change: GitConfigSectionChange = { branches: new Set(), remotes: false, other: false };
  for (const key of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(key) === next.get(key)) {
      continue;
    }
    const separator = key.indexOf(" ");
    const section = separator < 0 ? key : key.slice(0, separator);
    const subsection = separator < 0 ? "" : key.slice(separator + 1);
    if (section === "branch" && subsection) {
      change.branches.add(subsection);
    } else if (section === "remote") {
      change.remotes = true;
    } else {
      change.other = true;
    }
  }
  return change;
}

function gitConfigSectionKey(line: string): string {
  const quoted = /^\s*\[\s*([^\s"\]]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(line);
  if (quoted) {
    return `${(quoted[1] ?? "").toLowerCase()} ${(quoted[2] ?? "").replace(/\\(.)/g, "$1")}`;
  }
  const plain = /^\s*\[\s*([^\s"\]]+)\s*\]/.exec(line);
  if (!plain) {
    // Unparsed headers still count as a change to "other" settings.
    return line.trim();
  }
  // The deprecated `[section.subsection]` form is case-insensitive throughout.
  const name = (plain[1] ?? "").toLowerCase();
  const dot = name.indexOf(".");
  return dot < 0 ? name : `${name.slice(0, dot)} ${name.slice(dot + 1)}`;
}
