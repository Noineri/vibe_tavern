import { useSyncExternalStore } from "react";
import {
  getBuildPanels,
  subscribeBuildPanels,
} from "../lib/build-panel-registry.js";

export function useBuildPanels() {
  return useSyncExternalStore(subscribeBuildPanels, getBuildPanels);
}
