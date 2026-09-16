/**
 * ImageBlock — the chat's shared justified image row (IMAGE_GENERATION_PLAN
 * IG-CF6; owner-named 2026-09-15: "this will then be the image block"). One
 * primitive for BOTH image kinds in chat: image-gen slot attachments (via
 * AttachmentGrid) and inline markdown images (CF7).
 *
 * Display pattern = the media-gallery tile (GalleryGrid), reusing the
 * gallery's OWN budget by import — fixed image HEIGHT (350 desktop / 220
 * mobile), tile WIDTH derived from each image's aspect ratio (portrait
 * narrow, landscape wide), panorama cap, object-cover overflow,
 * cursor-zoom-in, aspect-ratio cache against open-time twitch. Click opens
 * the shared FloatingImageViewer (zoom/pan).
 *
 * Optional caption line under the image — the gallery caption idiom (italic
 * t3, clamped), with the full text one click away: the caption toggles
 * between the clamped line and the full multi-line text. The image-gen slot
 * renders its generation prompt (provenance.prompt) there.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import {
  justifiedTileHeight,
  justifiedTileWidth,
  MAX_TILE_WIDTH_RATIO,
} from "../build/editors/GalleryGrid.js";
import { FloatingImageViewer } from "../build/editors/GalleryViewer.js";

export interface ImageBlockImage {
  src: string;
  alt: string;
  /** One-line caption under the image (clamped; click expands to full text). */
  caption?: string;
}

export interface ImageBlockProps {
  images: ImageBlockImage[];
  /** Extends the row container (e.g. the attachment area's top margin). */
  className?: string;
}

/** Module-level aspect-ratio cache, keyed by src (the GalleryGrid idiom).
 *  Survives tile re-render/remount so re-rendering a chat never reflows from
 *  a throwaway square footprint to the real aspect-derived width. */
const aspectCache = new Map<string, number>();

export function ImageBlock({ images, className }: ImageBlockProps) {
  const isMobile = useIsMobile();
  const tileHeight = justifiedTileHeight(isMobile);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openImage = openIndex !== null ? images[openIndex] : undefined;

  return (
    <>
      <div data-testid="image-block" className={cn("flex flex-wrap gap-3 select-none", className)}>
        {images.map((image, idx) => (
          <ImageBlockTile
            key={`${image.src}-${idx}`}
            image={image}
            tileHeight={tileHeight}
            onOpen={() => setOpenIndex(idx)}
          />
        ))}
      </div>
      {openImage && (
        <FloatingImageViewer
          src={openImage.src}
          alt={openImage.alt}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  );
}

function ImageBlockTile({
  image,
  tileHeight,
  onOpen,
}: {
  image: ImageBlockImage;
  tileHeight: number;
  onOpen: () => void;
}) {
  const { t } = useT();
  const imgRef = useRef<HTMLImageElement>(null);
  const caption = image.caption?.trim();
  const [expanded, setExpanded] = useState(false);

  // Orientation-aware width (justified layout): the tile width is derived
  // from the fixed image height × aspect ratio. The ratio is seeded from the
  // module-level aspectCache, refined synchronously before paint when the
  // browser already has the bitmap decoded, and confirmed on load. Until
  // known we reserve a square footprint (GalleryGrid's behavior).
  const [ratio, setRatio] = useState<number | null>(() => aspectCache.get(image.src) ?? null);
  const tileWidth = justifiedTileWidth(ratio, tileHeight);

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (ratio == null && img?.complete && img.naturalWidth && img.naturalHeight) {
      const r = img.naturalWidth / img.naturalHeight;
      aspectCache.set(image.src, r);
      setRatio(r);
    }
  }, [ratio, image.src]);

  return (
    <div
      className="group relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-border/50 bg-s3/30 transition-all hover:border-accent hover:shadow-md"
      style={{ width: `calc(${tileWidth}px * ${MAX_TILE_WIDTH_RATIO} + 8%)`, maxWidth: "100%" }}
    >
      {/* Image area — fixed height; width follows the tile (aspect-derived). */}
      <div className="relative w-full" style={{ height: tileHeight }}>
        <img
          ref={imgRef}
          src={image.src}
          alt={image.alt}
          data-testid="image-block-img"
          // object-cover: the tile width is derived from the image's own
          // aspect ratio, so cover == contain for the common case; only
          // ultra-wide panoramas (capped width) crop slightly.
          className="h-full w-full cursor-zoom-in object-cover"
          loading="lazy"
          draggable={false}
          onClick={onOpen}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              const r = img.naturalWidth / img.naturalHeight;
              aspectCache.set(image.src, r);
              setRatio(r);
            }
          }}
        />
      </div>

      {caption !== undefined && (
        <button
          type="button"
          data-testid="image-block-caption"
          aria-label={t("image_gen_slot_prompt")}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="w-full cursor-pointer px-2 py-1 text-left font-ui text-[calc(var(--ui-fs)-3px)] italic text-t3 transition-colors hover:text-t1"
        >
          <span className={cn("block break-words", expanded ? "whitespace-pre-wrap" : "line-clamp-1")}>
            {caption}
          </span>
        </button>
      )}
    </div>
  );
}
