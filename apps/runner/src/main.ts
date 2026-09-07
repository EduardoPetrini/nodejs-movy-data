/**
 * Movy run driver.
 *
 * Forked once per migration run by the web app. Owns process-level concerns the
 * core library must not: argv parsing, signal handling, IPC framing, the event
 * journal and exit codes.
 *
 * Scaffolded in Phase 0 so the three-app layout is settled before anything is
 * built against it. Implemented in Phase 1.
 */
export {};
