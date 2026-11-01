- The project is now Osiris. The name changes everywhere a user or reader
  saw it: the browser tab, HUD title and loading screen, the first-run tip,
  the OSIRIS MIC button and voice prompts, the web app manifest, Pinokio,
  Docker Compose, the MCP server (`serverInfo.name` is `osiris` and the
  tool is `show_in_osiris`; `show_in_gods_eye_view` still works as a hidden
  alias for one release), the package name and its `osiris/...` imports, and
  the documentation. Saved panel layouts, Director scenes, camera
  calibrations and voice preferences move to the new `osiris.*` storage
  keys on first start. Upstream attribution stays in `LICENSE` and the
  README credits line (JWilksBooth, #2).
