import type { ReactElement, ReactNode } from "react";
import { CustomTooltip } from "../shared/Tooltip.js";

export function withThemeTunerTooltip(content: ReactNode, control: ReactElement) {
  return <CustomTooltip content={content}>{control}</CustomTooltip>;
}
