import path from "node:path";

/** Keep machine runtime dependencies without inheriting user homes, profiles or credentials. */
export function isolatedWindowsEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "ComSpec",
    "windir",
    "SystemDrive",
    "PATHEXT",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "ProgramData",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
  ]) {
    const value = values.get(key.toLowerCase());
    if (value) result[key] = value;
  }
  const moduleRoots: string[] = [];
  const windows = result.SystemRoot ?? result.windir;
  if (windows)
    moduleRoots.push(path.win32.join(windows, "System32/WindowsPowerShell/v1.0/Modules"));
  if (result.ProgramFiles)
    moduleRoots.push(path.win32.join(result.ProgramFiles, "WindowsPowerShell/Modules"));
  if (moduleRoots.length) result.PSModulePath = moduleRoots.join(";");
  return result;
}
