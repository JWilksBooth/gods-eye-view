/**
 * Directories the app writes to while it runs. None is source, and none
 * should reload anything.
 */
const RUNTIME_WRITE_GLOBS = Object.freeze([
  '**/.gev-cache/**',
  '**/.gev-logs/**',
]);

/**
 * Where Claude Code keeps its per-checkout state: settings, the launch
 * configuration and, under `worktrees/`, a full git worktree per session.
 * Each worktree is another copy of the source tree, so watching `.claude`
 * multiplies the watcher's work by the number of open sessions. On a
 * cloud-synced folder that cost the dev server a minute of blocked event loop
 * at startup, long enough for every camera pack's download to time out.
 */
const TOOL_STATE_GLOBS = Object.freeze(['**/.claude/**']);

/** Every glob the dev watcher leaves alone, in the order the plugin lists them. */
export const UNWATCHED_GLOBS = Object.freeze([
  ...RUNTIME_WRITE_GLOBS,
  ...TOOL_STATE_GLOBS,
]);

/**
 * Keep the directories the app writes to, and the editor's session state, out
 * of the dev server's file watcher.
 *
 * Disk-cached providers write a file per response into `.gev-cache`, and the
 * voice debug log appends to `.gev-logs`. Left watched, each write costs the
 * watcher stat calls on libuv's thread pool, which `getaddrinfo` shares; heavy
 * cache writes have been seen to delay upstream DNS lookups. `.claude` holds
 * whole worktrees, which the watcher would otherwise walk at every start.
 *
 * @returns {import('vite').Plugin} Config-only plugin; no server hooks.
 */
export function unwatchedRuntimeDirsPlugin() {
  return {
    name: 'gev-unwatched-runtime-dirs',
    apply: 'serve',
    config: () => ({
      server: { watch: { ignored: [...UNWATCHED_GLOBS] } },
    }),
  };
}
