import { useEffect, useRef, useState } from "react";
import { Icons } from "../../shared/icons.js";
import { ExperienceFrame } from "../../experience/ExperienceFrame.js";

interface ExperienceCardPreviewProps {
  /** The bound visual's source to render, or `null` when no visual is bound. */
  visualSource: string | null;
}

/**
 * ExperienceCardPreview — the lazy visual preview area at the top of a mini-app
 * card in the picker (XU-7).
 *
 * With no bound visual it renders a gradient placeholder (a centered stack
 * icon). With a source it mounts the sandboxed {@link ExperienceFrame} ONLY
 * once the card scrolls into view (`IntersectionObserver`, disconnected after
 * the first intersection), so a long picker list never spins up dozens of
 * iframes at once. The frame is a DISCONNECTED render (no session) mirroring
 * the shell's preview tab: an empty initial view is pushed on ready so the
 * visual's `render()` fires, and actions/errors are no-ops.
 */
export function ExperienceCardPreview({ visualSource }: ExperienceCardPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    // No source (or the visual was unbound) → never mount the frame; drop any
    // previously-set in-view flag so a later rebind re-observes lazily.
    if (visualSource === null) {
      setInView(false);
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visualSource]);

  const showFrame = visualSource !== null && inView;

  return (
    <div
      ref={containerRef}
      data-testid="experience-card-preview"
      className="pointer-events-none h-28 overflow-hidden rounded-t-xl"
    >
      {showFrame ? (
        <ExperienceFrame
          visualSource={visualSource}
          sessionId="card-preview"
          initialRevision={0}
          initialView={{ state: {}, actions: [], revision: 0, status: "active" }}
          onAction={() => {}}
          onError={() => {}}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-accent-dim text-accent-t">
          <Icons.Stack />
        </div>
      )}
    </div>
  );
}
