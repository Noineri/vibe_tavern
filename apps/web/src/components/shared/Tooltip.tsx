import * as Tooltip from "@radix-ui/react-tooltip";
import React from "react";

interface CustomTooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function CustomTooltip({ children, content, side = "top", align = "center" }: CustomTooltipProps) {
  if (!content) return <>{children}</>;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="z-50 rounded-md bg-t1 px-2.5 py-1.5 text-xs text-bg shadow-md animate-in fade-in zoom-in-95 duration-150"
          side={side}
          align={align}
          sideOffset={5}
        >
          {content}
          <Tooltip.Arrow className="fill-t1" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const TooltipProvider = Tooltip.Provider;
