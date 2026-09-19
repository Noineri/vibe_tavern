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
 * Optional prompt accordion under the image (MR-8, owner spec 2026-09-18):
 * at rest a compact collapsed row — chevron + «Prompt» label, NO prompt
 * text — one click opens the full multi-line text (pre-wrap, italic t3).
 * The app-wide accordion idiom (ExperienceEditor technical details):
 * rotating Ic.caret + AnimatedDisclosure. The image-gen slot renders its
 * generation prompt (provenance.prompt) there.
 */

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "../../lib/cn.js";
import { useT } from "../../i18n/context.js";
import { Ic } from "../shared/icons.js";
import { AnimatedDisclosure } from "../shared/AnimatedDisclosure.js";
import { FloatingImageViewer } from "../build/editors/GalleryViewer.js";
import { AutoTextarea } from "../shared/auto-textarea.js";

export interface ImageBlockImage {
  src: string;
  alt: string;
  /** Generation prompt shown under the image inside the MR-8 accordion. */
  caption?: string;
  /** MR-9: when present, the expanded accordion offers an inline prompt
   *  editor. The callback persists the new text (chat-api → prompt-write
   *  route) and resolves true on success — false keeps the editor open.
   *  Absent on surfaces with no persistence behind them (markdown inline
   *  images): they render the accordion read-only. */
  onEditPrompt?: (next: string) => Promise<boolean>;
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
  // MR-9: inline prompt editor INSIDE the accordion (owner 2026-09-18:
  // «да, в аккордеоне» — no popover). Draft seeds from the current prompt;
  // Save persists via onEditPrompt and exits edit mode on success only.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setDraft(caption ?? "");
    setEditing(true);
  };

  const savePrompt = async () => {
    if (!image.onEditPrompt || saving) return;
    setSaving(true);
    try {
      const ok = await image.onEditPrompt(draft);
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };

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
        <>
          {/* Collapsed row: chevron + label ONLY (MR-8 — the prompt text is
              never a wall under the image at rest). Canon accordion idiom
              (ExperienceEditor technical details): rotating Ic.caret. */}
          <button
            type="button"
            data-testid="image-block-caption"
            aria-label={t("image_gen_slot_prompt")}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left font-ui text-[calc(var(--ui-fs)-3px)] font-semibold uppercase tracking-[0.06em] text-t3 transition-colors hover:text-t1"
          >
            <span
              className="inline-block text-t3 transition-transform"
              style={{ transform: expanded ? "rotate(90deg)" : "none" }}
            >
              {Ic.caret("r")}
            </span>
            <span>{t("image_block_prompt_row")}</span>
          </button>
          <AnimatedDisclosure open={expanded} className="px-2 pb-2">
            {editing ? (
              <div data-testid="image-block-prompt-editor" className="flex flex-col gap-1.5">
                {/* The canon auto-growing field (FS-8b: className extends the
                    baked base); mono is NOT used — this is prose, not code. */}
                <AutoTextarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  minRows={3}
                  maxRows={12}
                  disabled={saving}
                  autoFocus
                />
                {/* Canon compact pair (destructive-confirm shape): cancel =
                    quiet bordered, confirm = accent; Save disabled while
                    saving or on an empty draft (the server rejects empty). */}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    data-testid="image-block-prompt-cancel"
                    className="h-8 cursor-pointer rounded-md border border-border bg-transparent px-3.5 font-ui text-[12.5px] text-t3 transition-colors duration-150 hover:text-t1"
                    disabled={saving}
                    onClick={() => setEditing(false)}
                  >
                    {t("cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="image-block-prompt-save"
                    className="h-8 cursor-pointer rounded-md border-0 bg-accent px-[18px] font-ui text-[12.5px] font-medium text-on-accent transition-[filter] duration-100 hover:brightness-110 disabled:opacity-50"
                    disabled={saving || draft.trim() === ""}
                    onClick={() => void savePrompt()}
                  >
                    {saving ? t("saving") : t("save")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span
                  data-testid="image-block-caption-text"
                  className="block break-words whitespace-pre-wrap font-ui text-[calc(var(--ui-fs)-3px)] italic text-t3"
                >
                  {caption}
                </span>
                {image.onEditPrompt !== undefined && (
                  <button
                    type="button"
                    data-testid="image-block-prompt-edit"
                    className="flex self-start h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-s3 px-2.5 font-ui text-[calc(var(--ui-fs)-3px)] text-t2 transition-all hover:bg-s2 hover:text-t1"
                    onClick={startEdit}
                  >
                    <Ic.edit />
                    {t("image_block_prompt_edit")}
                  </button>
                )}
              </div>
            )}
          </AnimatedDisclosure>
        </>
      )}
    </div>
  );
}
