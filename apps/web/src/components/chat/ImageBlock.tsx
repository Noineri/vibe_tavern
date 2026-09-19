/**
 * ImageBlock — the chat's shared image row (IMAGE_GENERATION_PLAN IG-CF6;
 * owner-named 2026-09-15: "this will then be the image block"). One
 * primitive for BOTH image kinds in chat: image-gen slot attachments (via
 * AttachmentGrid) and inline markdown images (CF7).
 *
 * Display pattern = orientation-driven message sizing (MR-7, owner spec
 * 2026-09-18 — replaces the v1 justified-gallery budget): landscape (w>h)
 * stretches to the FULL message-container width; portrait and square take
 * HALF (two half tiles share a row through the flex-wrap gap). Heights are
 * ratio-true — the img carries CSS aspect-ratio, so nothing crops — and a
 * tall image's height never exceeds ~70% of the viewport: the width is
 * min(bucket, 70vh × ratio), i.e. the tile SHRINKS instead of growing
 * past the cap. object-cover stays for subpixel equivalence (cover ≡
 * contain when the box is ratio-true), cursor-zoom-in, aspect-ratio cache
 * against open-time twitch. Click opens the shared FloatingImageViewer
 * (zoom/pan).
 *
 * Optional caption line under the image — the gallery caption idiom (italic
 * t3, clamped), with the full text one click away: the caption toggles
 * between the clamped line and the full multi-line text. The image-gen slot
 * renders its generation prompt (provenance.prompt) there.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
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
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const openImage = openIndex !== null ? images[openIndex] : undefined;

  return (
    <>
      <div data-testid="image-block" className={cn("flex flex-wrap gap-3 select-none", className)}>
        {images.map((image, idx) => (
          <ImageBlockTile key={`${image.src}-${idx}`} image={image} onOpen={() => setOpenIndex(idx)} />
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

function ImageBlockTile({ image, onOpen }: { image: ImageBlockImage; onOpen: () => void }) {
  const { t } = useT();
  const imgRef = useRef<HTMLImageElement>(null);
  const caption = image.caption?.trim();
  const [expanded, setExpanded] = useState(false);

  // Orientation bucket (MR-7, owner spec 2026-09-18): the ratio is seeded
  // from the module-level aspectCache, refined synchronously before paint
  // when the browser already has the bitmap decoded, and confirmed on load.
  // Until known we reserve a square footprint at the portrait bucket width.
  // The bucket classes (styles.css @layer components) carry the width
  // formula incl. the 70vh cap; the per-tile ratio rides --tile-ratio.
  const [ratio, setRatio] = useState<number | null>(() => aspectCache.get(image.src) ?? null);
  const bucketCls = ratio !== null && ratio > 1 ? "image-tile-landscape" : "image-tile-portrait";

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
      className={cn(
        "group relative flex shrink-0 flex-col overflow-hidden rounded-lg border border-border/50 bg-s3/30 transition-all hover:border-accent hover:shadow-md",
        bucketCls,
      )}
      style={{ "--tile-ratio": `${ratio ?? 1}` } as CSSProperties}
    >
      {/* Image area — ratio-true: the img's CSS aspect-ratio drives the
          height, so the bucket width maps to the image's own proportions. */}
      <div className="relative w-full">
        <img
          ref={imgRef}
          src={image.src}
          alt={image.alt}
          data-testid="image-block-img"
          // object-cover: the box is ratio-true (width × aspect-ratio), so
          // cover ≡ contain — cover stays only for subpixel safety.
          className="w-full cursor-zoom-in object-cover"
          style={{ aspectRatio: `${ratio ?? 1}` }}
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
