import React, { useCallback, useState } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { cn } from "../../../lib/cn.js";
import { Icons } from "../../shared/icons.js";
import { Checkbox } from "../../shared/Checkbox.js";
import { serveCharacterAssetUrl } from "../../../api/gallery-api.js";
import type { CharacterAsset } from "@vibe-tavern/domain";
import { useT } from "../../../i18n/context.js";
import { useGalleryStore } from "../../../stores/gallery-store.js";
import { GalleryViewer } from "./GalleryViewer.js";

interface GalleryGridProps {
  characterId: string;
  assets: CharacterAsset[];
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onSetAvatar: (asset: CharacterAsset) => void;
}

function DraggableGridItem({
  characterId,
  asset,
  isSelected,
  onToggle,
  onOpenViewer,
  onDescribe,
  onSetAvatar,
  onDelete,
}: {
  characterId: string;
  asset: CharacterAsset;
  isSelected: boolean;
  onToggle: () => void;
  onOpenViewer: () => void;
  onDescribe: () => void;
  onSetAvatar: () => void;
  onDelete: () => void;
}) {
  const { t } = useT();
  const id = asset.id as string;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  const { setNodeRef: setDropNodeRef } = useDroppable({ id });
  const describingSet = useGalleryStore((s) => s.describing[characterId]);
  const isDescribing = describingSet?.has(id);

  // We assign both ref setters to the same DOM node using a callback ref
  const setBothRefs = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      setDropNodeRef(node);
    },
    [setNodeRef, setDropNodeRef]
  );

  return (
    <div
      ref={setBothRefs}
      className={cn(
        "group relative flex aspect-square w-full cursor-grab overflow-hidden rounded-lg border bg-s2/50 shadow-sm transition-all active:cursor-grabbing",
        isSelected ? "border-accent ring-1 ring-accent" : "border-border/50 hover:border-accent hover:shadow-md",
        isDragging && "opacity-50 z-10"
      )}
      {...attributes}
      {...listeners}
    >
      <img
        src={serveCharacterAssetUrl(characterId, id)}
        alt={asset.caption || "Gallery image"}
        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        loading="lazy"
        draggable={false}
      />
      {asset.caption && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1.5 py-0.5 text-[10px] text-white/80 truncate">
          {asset.caption}
        </div>
      )}
      {asset.description && !isDescribing && (
        <div className="absolute top-1 right-1 flex items-center justify-center rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-bold uppercase text-on-accent shadow-sm">
          {t("gallery_described_badge")}
        </div>
      )}
      {isDescribing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <span className="block h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white" />
        </div>
      )}

      {/* Selection checkbox (top left) */}
      <div
        className={cn(
          "absolute left-1 top-1 z-20 p-1 transition-opacity",
          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        )}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Checkbox checked={isSelected} onChange={onToggle} />
      </div>

      {/* Hover action bar (bottom right, above caption) */}
      <div
        className="absolute bottom-6 right-1 z-20 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button type="button" onClick={onOpenViewer} className="flex h-7 w-7 items-center justify-center rounded bg-black/60 text-white transition-colors hover:bg-accent hover:text-on-accent" title={t("gallery_expand")}>
          <Icons.expand className="h-4 w-4" />
        </button>
        <button type="button" onClick={onDescribe} disabled={isDescribing} className="flex h-7 w-7 items-center justify-center rounded bg-black/60 text-white transition-colors hover:bg-accent hover:text-on-accent disabled:opacity-50" title={t("gallery_describe")}>
          <Icons.eye className="h-4 w-4" />
        </button>
        <button type="button" onClick={onSetAvatar} className="flex h-7 w-7 items-center justify-center rounded bg-black/60 text-white transition-colors hover:bg-accent hover:text-on-accent" title={t("gallery_set_avatar")}>
          <Icons.user className="h-4 w-4" />
        </button>
        <button type="button" onClick={onDelete} className="flex h-7 w-7 items-center justify-center rounded bg-black/60 text-danger transition-colors hover:bg-danger hover:text-on-danger" title={t("delete")}>
          <Icons.del className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const mouseSensorOptions = { activationConstraint: { distance: 2 } };
const touchSensorOptions = { activationConstraint: { distance: 2 } };

export function GalleryGrid({ characterId, assets, selectedIds, onToggleSelection, onSetAvatar }: GalleryGridProps) {
  const { t } = useT();
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const reorder = useGalleryStore((s) => s.reorder);
  const remove = useGalleryStore((s) => s.remove);
  const describe = useGalleryStore((s) => s.describe);

  const sensors = useSensors(
    useSensor(MouseSensor, mouseSensorOptions),
    useSensor(TouchSensor, touchSensorOptions)
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = assets.findIndex((a) => a.id === active.id);
    const newIndex = assets.findIndex((a) => a.id === over.id);

    if (oldIndex !== -1 && newIndex !== -1) {
      const nextList = [...assets];
      const [item] = nextList.splice(oldIndex, 1);
      nextList.splice(newIndex, 0, item);
      void reorder(characterId, nextList.map((a) => a.id as string));
    }
  };

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {assets.map((asset, idx) => (
            <DraggableGridItem
              key={asset.id as string}
              characterId={characterId}
              asset={asset}
              isSelected={selectedIds.has(asset.id as string)}
              onToggle={() => onToggleSelection(asset.id as string)}
              onOpenViewer={() => setViewerIndex(idx)}
              onDescribe={() => { void describe(characterId, [asset.id as string]); }}
              onSetAvatar={() => onSetAvatar(asset)}
              onDelete={() => { void remove(characterId, asset.id as string); }}
            />
          ))}
        </div>
      </DndContext>

      {viewerIndex !== null && (
        <GalleryViewer
          characterId={characterId}
          asset={assets[viewerIndex]}
          onClose={() => setViewerIndex(null)}
          onPrev={assets.length > 1 ? () => setViewerIndex((i) => (i! - 1 + assets.length) % assets.length) : undefined}
          onNext={assets.length > 1 ? () => setViewerIndex((i) => (i! + 1) % assets.length) : undefined}
        />
      )}
    </>
  );
}
