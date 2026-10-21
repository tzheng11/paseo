# Workspace nesting feedback: isolated QA

Source: [4660bf8d15a5061bd08213450866d58432517eea](https://github.com/tzheng11/paseo/commit/4660bf8d15a5061bd08213450866d58432517eea).

These three images use disposable Playwright fixture workspaces and an isolated daemon. They contain no production workspaces, provider logs, credentials, or user data. This orphan QA branch contains images and this README only; it changes no application source or build inputs.

The browser regression drags the whole Child row onto Parent, shows the named target inside the drag preview, holds the real move response to verify pending feedback without early success, then checks the saved parent and 16 px indentation after reload. A cross-project drop shows its full rejection reason and preserves the existing parent. A separate browser case verifies keyboard ordering, intentional nesting, and lifting out.

## Visual proof

### Named target during drag

![The drag preview names the intended parent](workspace-nesting-target.png)

### Confirmed saved nesting

![Saved nesting confirmation with the child indented](workspace-nesting-confirmed.png)

### Blocked cross-project drop

![The complete blocked-drop reason is visible in the drag preview](workspace-nesting-blocked.png)

## Executed focused checks

From `packages/app`:

```sh
npx vitest run src/components/sidebar/workspace-tree/drop-target.test.ts --project unit --bail=1
# Test Files  1 passed (1)
#      Tests  14 passed (14)

npm run test:e2e -- --grep 'workspace nesting names its target, confirms persistence, and explains blocked drops' --workers 1 --max-failures 1
# 1 passed (45.3s; case 16.8s)

npm run test:e2e -- --grep 'keyboard workspace dragging reorders, intentionally nests, and lifts out' --workers 1 --max-failures 1
# 1 passed (22.7s; case 3.7s)
```

Browser web was exercised for the drag/drop flows above. Native iOS/Android devices and Windows/Linux desktop packages were not exercised. The macOS package smoke is documented below.


## macOS packaged app smoke

![Isolated packaged macOS welcome screen](desktop-macos-welcome.png)

The macOS ARM64 package for source `4660bf8d15a5061bd08213450866d58432517eea` passed deep strict signature verification across its native chain (23 signed Mach-O files). Packaged `node-pty`, `msgpackr-extract`, and `sherpa-onnx-node` loaded, and packaged esbuild executed under Electron 44.2.0 / Node 24.20.0.

A real isolated Electron GUI reached the welcome route with its native bridge available, zero page or console errors, a verified browser PID matching the exact packaged executable, and a clean exit with code 0. Desktop daemon management was disabled for this smoke; its user data and daemon home were disposable. The screenshot shows that isolated welcome route. Interactive nesting coverage comes from the browser cases above.
