- Dev server: the file watcher now leaves `.claude` alone, where Claude Code
  keeps a full git worktree per session. On a cloud-synced checkout, walking
  those copies blocked the server's event loop for about a minute at every
  start, long enough for the camera packs' downloads to time out, so the app
  showed a partial camera list until the catalog's next refresh
  (JWilksBooth, #21).
