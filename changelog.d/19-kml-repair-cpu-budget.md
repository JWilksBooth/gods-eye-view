- Stop the KML import suite failing on a busy machine: the test that guards the
  root-tag repair against hostile files now budgets the repair's CPU time in its
  child process instead of giving the child, which first loads Cesium, five
  seconds of wall-clock time; a generous ceiling scaled to the suite's own load
  time remains as the hang guard. The importer is unchanged (JWilksBooth, #19).
