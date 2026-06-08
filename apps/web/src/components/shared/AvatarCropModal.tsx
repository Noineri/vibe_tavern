import { useCallback, useState } from "react";
import Cropper from "react-easy-crop";
import type { Area, Point } from "react-easy-crop";
import { Modal } from "./Modal.js";
import { useT } from "../../i18n/context.js";

export interface AvatarCropResult {
  /** Cropped square image as a File (512×512 PNG) */
  croppedFile: File;
}

interface AvatarCropModalProps {
  imageUrl: string;
  /** Name used for the cropped File's filename */
  fileName?: string;
  onConfirm: (result: AvatarCropResult) => void;
  onCancel: () => void;
}

const CROP_SIZE = 512;

function cropImageToBlob(imageSrc: string, pixelCrop: Area): Promise<Blob> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  return new Promise((resolve, reject) => {
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = CROP_SIZE;
      canvas.height = CROP_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No canvas context"));

      ctx.drawImage(
        image,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        CROP_SIZE,
        CROP_SIZE,
      );

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas toBlob failed"));
        },
        "image/png",
        1,
      );
    };
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = imageSrc;
  });
}

export function AvatarCropModal({
  imageUrl,
  fileName = "avatar_cropped.png",
  onConfirm,
  onCancel,
}: AvatarCropModalProps) {
  const { t } = useT();
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [confirming, setConfirming] = useState(false);

  const onCropComplete = useCallback((_croppedPercentages: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!croppedAreaPixels) return;
    setConfirming(true);
    try {
      const blob = await cropImageToBlob(imageUrl, croppedAreaPixels);
      const croppedFile = new File([blob], fileName, { type: "image/png" });
      onConfirm({ croppedFile });
    } catch (err) {
      console.error("Crop failed:", err);
    } finally {
      setConfirming(false);
    }
  }, [imageUrl, croppedAreaPixels, fileName, onConfirm]);

  return (
    <Modal open={true} onClose={onCancel}>
      <div
        className="bg-surface border border-border2 rounded-xl max-w-[calc(100vw-32px)] max-h-[calc(100vh-60px)] flex flex-col shadow-[0_24px_60px_rgba(0,0,0,.5)] overflow-hidden"
        style={{ width: "420px" }}
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

        {/* Body — crop area */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex flex-col items-center gap-4">
            <div
              className="relative rounded-lg overflow-hidden bg-s2"
              style={{ width: 320, height: 320 }}
            >
              <Cropper
                image={imageUrl}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                cropSize={{ width: 320, height: 320 }}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
                style={{
                  containerStyle: { width: 320, height: 320 },
                }}
              />
            </div>

            {/* Zoom slider */}
            <div className="flex w-full items-center gap-3 px-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="shrink-0 text-t3">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="crop-zoom-slider flex-1"
              />
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" className="shrink-0 text-t3">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                <line x1="8" y1="11" x2="14" y2="11" />
                <line x1="11" y1="8" x2="11" y2="14" />
              </svg>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2.5 border-t border-border px-5 py-[14px] shrink-0">
          <button type="button"
            className="h-[37px] cursor-pointer rounded-md bg-transparent py-0 px-4 font-ui text-[calc(var(--ui-fs)-2px)] text-t3 transition-all hover:text-t1"
            onClick={onCancel}
            disabled={confirming}
          >
            {t("cancel")}
          </button>
          <button type="button"
            className="h-[37px] cursor-pointer rounded-md bg-accent py-0 px-[21px] font-ui text-[calc(var(--ui-fs)-2px)] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
            onClick={() => void handleConfirm()}
            disabled={confirming}
          >
            {confirming ? "..." : t("save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
