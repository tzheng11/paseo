// Test-only observation of the owned detached worker. Never log arguments,
// environment, paths, command output or private worker-record contents.
if (process.argv.includes("--paseo-terminal-worker")) {
  const seen = new Set();
  function phase(value) {
    if (seen.has(value)) return;
    seen.add(value);
    try {
      process.stderr.write(`[fixture-terminal-startup] ${value}\n`);
    } catch {
      // Observations never change the launch outcome.
    }
  }
  phase("preload");
  const net = require("node:net");
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    phase("listen-start");
    this.once("listening", () => phase("listening"));
    return listen.apply(this, args);
  };
  const cp = require("node:child_process");
  const execFile = cp.execFile;
  const custom = require("node:util").promisify.custom;
  cp.execFile = function (file, ...args) {
    phase("command-start");
    const callback = args.at(-1);
    if (typeof callback === "function")
      args[args.length - 1] = function (error, ...rest) {
        phase(error ? "command-error" : "command-complete");
        return callback.call(this, error, ...rest);
      };
    return execFile.call(this, file, ...args);
  };
  if (execFile[custom])
    cp.execFile[custom] = function (...args) {
      phase("command-start");
      const pending = execFile[custom].apply(this, args);
      void pending.then(
        () => phase("command-complete"),
        () => phase("command-error"),
      );
      return pending;
    };
  const fs = require("node:fs");
  for (const name of ["writeSync", "closeSync"]) {
    const original = fs[name];
    fs[name] = function (...args) {
      if (args[0] !== 3) return original.apply(this, args);
      phase(`fd3-${name}-start`);
      try {
        const result = original.apply(this, args);
        phase(`fd3-${name}-complete`);
        return result;
      } catch (error) {
        const code = /^[A-Z0-9_]+$/.test(error?.code) ? error.code : "unknown";
        phase(`fd3-${name}-error:${code}`);
        throw error;
      }
    };
  }
  require("node:module").syncBuiltinESMExports();
}
