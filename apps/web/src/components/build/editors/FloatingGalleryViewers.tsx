import { GalleryViewer } from "./GalleryViewer.js";
import { useFloatingGalleryStore } from "../../../stores/floating-gallery-store.js";

/**
 * Global host for the floating gallery viewers (owner fix 2026-10-20).
 * Mounted ONCE in `App` next to `AppShell`, so open viewers survive both a
 * chat character switch and a Build character switch (including the Build
 * grid unmounting under a collapsed accordion). Renders one `GalleryViewer`
 * per store entry, each with the `characterId` it was opened with — a switch
 * never re-targets the URL; the user closes each window.
 */
export function FloatingGalleryViewers() {
  const viewers = useFloatingGalleryStore((s) => s.viewers);
  const closeGalleryViewer = useFloatingGalleryStore((s) => s.closeGalleryViewer);
  return (
    <>
      {viewers.map((v) => (
        <GalleryViewer
          key={`${v.characterId}:${v.asset.id as string}`}
          characterId={v.characterId}
          asset={v.asset}
          onClose={() => closeGalleryViewer(v.characterId, v.asset.id as string)}
        />
      ))}
    </>
  );
}
