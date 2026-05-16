import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useT } from "../../i18n/context";

/**
 * AvatarCropModal — canvas-based circular crop tool for avatar images.
 *
 * • Image rendered on a <canvas> with a semi-transparent mask darkening
 *   everything outside the circular crop area.
 * • User can drag to pan and use a zoom slider to scale.
 * • On confirm, an offscreen canvas produces a cropped square PNG blob
 *   (480 × 480) that renders perfectly in any circular avatar container.
 * • The original image URL is returned alongside the cropped URL so the
 *   caller can keep it for full-size preview features.
 */

export interface AvatarCropResult {
  /** Blob URL of the cropped square avatar — use for avatar displays */
  croppedUrl: string;
  /** Original untouched image URL — keep for full-size preview */
  originalUrl: string;
  /** The cropped File object for upload (derived from the blob) */
  croppedFile: File;
}

interface AvatarCropModalProps {
  imageUrl: string;
  originalFile: File;
  onConfirm: (result: AvatarCropResult) => void;
  onCancel: () => void;
}

/** Output size of the cropped avatar image in pixels */
const CROP_OUTPUT_SIZE = 480;

export function AvatarCropModal({
  imageUrl,
  originalFile,
  onConfirm,
  onCancel,
}: AvatarCropModalProps) {
  const { t } = useT();

  /* ── Refs ── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  /* ── State ── */
  const [naturalSize, setNaturalSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });
  const [imageLoaded, setImageLoaded] = useState(false);

  /* ── Derived: canvas display size (responsive) ── */
  const [canvasSize, setCanvasSize] = useState(320);
  const cropRadius = canvasSize / 2;

  /* ── Responsive canvas sizing ── */
  useEffect(() => {
    const measure = () => {
      const w = window.innerWidth;
      if (w < 480) setCanvasSize(Math.min(280, w - 80));
      else setCanvasSize(320);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /* ── Load image ── */
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
      const minDim = Math.min(img.naturalWidth, img.naturalHeight);
      const initialZoom = canvasSize / minDim;
      setZoom(initialZoom);
      setOffset({ x: 0, y: 0 });
      setImageLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl, canvasSize]);

  /* ── Canvas draw ── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageLoaded) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cw = canvasSize;
    const ch = canvasSize;
    canvas.width = cw * devicePixelRatio;
    canvas.height = ch * devicePixelRatio;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    ctx.scale(devicePixelRatio, devicePixelRatio);

    ctx.clearRect(0, 0, cw, ch);

    // Draw image centered
    const scaledW = naturalSize.w * zoom;
    const scaledH = naturalSize.h * zoom;
    const imgX = (cw - scaledW) / 2 + offset.x;
    const imgY = (ch - scaledH) / 2 + offset.y;
    ctx.drawImage(img, imgX, imgY, scaledW, scaledH);

    // Dark overlay — fill entire canvas, then cut out the circle
    ctx.save();
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.arc(cw / 2, ch / 2, cropRadius, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.restore();

    // Thin ring around crop area
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, cropRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }, [canvasSize, naturalSize, zoom, offset, cropRadius, imageLoaded]);

  useEffect(() => {
    draw();
  }, [draw]);

  /* ── Drag handlers (pointer events for mouse + touch) ── */
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      dragStart.current = {
        mx: e.clientX,
        my: e.clientY,
        ox: offset.x,
        oy: offset.y,
      };
    },
    [offset],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current.mx;
      const dy = e.clientY - dragStart.current.my;
      setOffset({
        x: dragStart.current.ox + dx,
        y: dragStart.current.oy + dy,
      });
    },
    [dragging],
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
  }, []);

  /* ── Compute zoom range ── */
  const minZoom = canvasSize / Math.max(naturalSize.w, naturalSize.h);
  const maxZoom = Math.max(
    (canvasSize / Math.min(naturalSize.w, naturalSize.h)) * 3,
    minZoom * 6,
  );

  /* ── Zoom handler (slider) ── */
  const handleZoomChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newZoom = parseFloat(e.target.value);
      const centerX = canvasSize / 2 - offset.x;
      const centerY = canvasSize / 2 - offset.y;
      const scale = newZoom / zoom;
      setOffset({
        x: canvasSize / 2 - centerX * scale,
        y: canvasSize / 2 - centerY * scale,
      });
      setZoom(newZoom);
    },
    [zoom, offset, canvasSize],
  );

  /* ── Zoom handler (mouse wheel) ── */
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const factor = 1 - e.deltaY * 0.001;
      const newZoom = Math.min(maxZoom, Math.max(minZoom, zoom * factor));
      // Zoom toward cursor position on canvas
      const rect = (e.target as HTMLElement).getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const imgCenterX = canvasSize / 2 - offset.x;
      const imgCenterY = canvasSize / 2 - offset.y;
      // How far the cursor is from the image center (in canvas pixels)
      const relX = cursorX - canvasSize / 2 - offset.x;
      const relY = cursorY - canvasSize / 2 - offset.y;
      const scale = newZoom / zoom;
      setOffset({
        x: canvasSize / 2 - imgCenterX * scale + relX * (1 - scale),
        y: canvasSize / 2 - imgCenterY * scale + relY * (1 - scale),
      });
      setZoom(newZoom);
    },
    [zoom, offset, canvasSize, minZoom, maxZoom],
  );

  /* ── Crop & confirm ── */
  const handleConfirm = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;

    const size = CROP_OUTPUT_SIZE;
    const offscreen = document.createElement("canvas");
    offscreen.width = size;
    offscreen.height = size;
    const ctx = offscreen.getContext("2d");
    if (!ctx) return;

    const imgX =
      (canvasSize - naturalSize.w * zoom) / 2 + offset.x;
    const imgY =
      (canvasSize - naturalSize.h * zoom) / 2 + offset.y;
    const cropCanvasX = canvasSize / 2 - cropRadius;
    const cropCanvasY = canvasSize / 2 - cropRadius;

    const outScale = size / (cropRadius * 2);

    ctx.drawImage(
      img,
      (imgX - cropCanvasX) * outScale,
      (imgY - cropCanvasY) * outScale,
      naturalSize.w * zoom * outScale,
      naturalSize.h * zoom * outScale,
    );

    offscreen.toBlob(
      (blob) => {
        if (!blob) return;
        const croppedUrl = URL.createObjectURL(blob);
        // Derive a filename for the cropped file
        const ext = originalFile.name.split(".").pop() || "png";
        const croppedFile = new File([blob], `cropped_${originalFile.name}`, {
          type: blob.type || `image/${ext}`,
        });
        onConfirm({ croppedUrl, originalUrl: imageUrl, croppedFile });
      },
      "image/png",
      0.92,
    );
  }, [
    canvasSize,
    cropRadius,
    naturalSize,
    zoom,
    offset,
    imageUrl,
    originalFile,
    onConfirm,
  ]);

  /* ── Render ── */
  return (
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        className="bg-surface border border-border2 rounded-xl max-w-[calc(100vw-32px)] max-h-[calc(100vh-60px)] flex flex-col shadow-[0_24px_60px_rgba(0,0,0,.5)] overflow-hidden"
        style={{ width: "420px" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 pt-[18px] px-5">
          <div className="font-body text-[calc(var(--ui-fs)+4px)] font-medium text-t1 mb-0.5">
            {t("crop_avatar_title")}
          </div>
          <div className="font-ui text-[calc(var(--ui-fs)-2px)] text-t3 mb-3.5">
            {t("crop_avatar_subtitle")}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          <div ref={containerRef} className="flex flex-col items-center gap-4">
            {/* Canvas area */}
            <div
              className="relative"
              style={{ width: canvasSize, height: canvasSize }}
            >
              {!imageLoaded && (
                <div
                  className="absolute inset-0 flex items-center justify-center rounded-lg bg-s2"
                  style={{ width: canvasSize, height: canvasSize }}
                >
                  <div className="gen-cur">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              )}
              <canvas
                ref={canvasRef}
                className={cn(
                  "rounded-lg touch-none",
                  dragging ? "cursor-grabbing" : "cursor-grab",
                )}
                style={{
                  width: canvasSize,
                  height: canvasSize,
                  opacity: imageLoaded ? 1 : 0,
                  transition: "opacity 0.15s",
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onWheel={handleWheel}
              />
            </div>

            {/* Zoom slider */}
            <div className="flex w-full items-center gap-3 px-1">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                className="shrink-0 text-t3"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              <input
                type="range"
                min={minZoom}
                max={maxZoom}
                step={maxZoom / 200}
                value={zoom}
                onChange={handleZoomChange}
                className="crop-zoom-slider flex-1"
              />
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                className="shrink-0 text-t3"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
                <line x1="11" y1="8" x2="11" y2="14" />
              </svg>
            </div>

            {/* Avatar preview (small circle) */}
            <div className="flex items-center gap-3 text-[calc(var(--ui-fs)-2px)] text-t3">
              <span>{t("crop_preview_label")}</span>
              <div
                className="overflow-hidden rounded-full border border-border2 bg-s2"
                style={{ width: 40, height: 40 }}
              >
                <canvas
                  ref={(el) => {
                    if (!el || !imageLoaded || !imgRef.current) return;
                    const pctx = el.getContext("2d");
                    if (!pctx) return;
                    const ps = 80;
                    el.width = ps;
                    el.height = ps;
                    el.style.width = "40px";
                    el.style.height = "40px";

                    const img = imgRef.current;
                    const imgX =
                      (canvasSize - naturalSize.w * zoom) / 2 + offset.x;
                    const imgY =
                      (canvasSize - naturalSize.h * zoom) / 2 + offset.y;
                    const cropCanvasX = canvasSize / 2 - cropRadius;
                    const cropCanvasY = canvasSize / 2 - cropRadius;

                    const outScale = ps / (cropRadius * 2);
                    pctx.drawImage(
                      img,
                      (imgX - cropCanvasX) * outScale,
                      (imgY - cropCanvasY) * outScale,
                      naturalSize.w * zoom * outScale,
                      naturalSize.h * zoom * outScale,
                    );
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2.5 border-t border-border px-5 py-[14px] shrink-0">
          <button
            type="button"
            className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110"
            onClick={handleConfirm}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
