// Shared runtime singletons populated at process startup by index.ts and
// consumed by routes / sub-agents at request time.
//
// This tiny module exists to break what would otherwise be a circular
// import: routes need the YAML-populated `lifecycle` instance, but
// index.ts already imports the routes (`registerChatRoute`, etc.). Going
// through this neutral module keeps the import graph acyclic — index.ts
// constructs the singleton AND populates hooks via loadHooks(); routes
// import the same instance and read it at request time when its hooks are
// fully registered.

import { Lifecycle } from "./lifecycle.js";

/**
 * Process-wide Lifecycle. Populated by `loadHooks()` in index.ts at startup
 * with all 9 YAML-registered hooks. Routes (chat / plan / sessions /
 * deep-research) and sub-agents share this single instance — there is no
 * per-request or per-sub-agent local Lifecycle anymore. That eliminates
 * the drift class of bug where a hook added to one builder silently
 * skipped the others.
 */
export const lifecycle = new Lifecycle();
