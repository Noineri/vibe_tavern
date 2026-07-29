import type { CSSProperties, ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

export interface AnimatedDisclosureProps {
  /** Whether the disclosure body is expanded. */
  open: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * Retain the body in the DOM while collapsed so local control state survives.
   * Collapsed retained content is inert and hidden from the accessibility tree.
   */
  keepMounted?: boolean;
  /** Optional test hook applied to the animated wrapper. */
  "data-testid"?: string;
}

const OPEN = { height: "auto", opacity: 1 } as const;
const CLOSED = { height: 0, opacity: 0 } as const;
const TRANSITION = { duration: 0.25, ease: "easeOut" } as const;

/**
 * Shared accordion-body transition: height 0 ↔ auto plus opacity, matching the
 * original LorebookAccordion motion exactly.
 */
export function AnimatedDisclosure({
  open,
  children,
  className,
  style,
  keepMounted = false,
  "data-testid": testId,
}: AnimatedDisclosureProps) {
  const mergedStyle: CSSProperties = { ...style, overflow: "hidden" };

  if (keepMounted) {
    return (
      <motion.div
        className={className}
        style={mergedStyle}
        initial={false}
        animate={open ? OPEN : CLOSED}
        transition={TRANSITION}
        inert={open ? undefined : true}
        aria-hidden={open ? undefined : true}
        data-testid={testId}
      >
        {children}
      </motion.div>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className={className}
          style={mergedStyle}
          initial={CLOSED}
          animate={OPEN}
          exit={CLOSED}
          transition={TRANSITION}
          data-testid={testId}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
