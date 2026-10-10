import type { StoreContainer } from "@vibe-tavern/db";
import { createTrackerDelegate } from "../../domain/coauthor/tracker/tracker-delegate.js";
import { createSessionLoreDelegate } from "./session-runtime-lore-delegate.js";

/**
 * Bind tracker-template delegation to the exact shared Co-Author connection
 * resolver used by lore delegation, while supplying the service-prompt DB.
 */
export async function createSessionTrackerDelegate(input: {
  stores: StoreContainer;
  buildDelegate: typeof createTrackerDelegate;
}) {
  const { stores, buildDelegate } = input;
  return createSessionLoreDelegate({
    stores,
    buildDelegate: (deps) => buildDelegate({ ...deps, db: stores.db }),
  });
}
