import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { DiceFaceShape, DiceAttempt } from "@vibe-tavern/domain";

export function glyphFor(faceShape: DiceFaceShape): { paths: ReactNode[]; fills?: ReactNode[]; valueDy?: number } {
  switch (faceShape) {
    case "d4":
      return {
        paths: [<path key="p" d="M12 3 L21 20 L3 20 Z" />],
        valueDy: 3.5,
      };
    case "d6":
      return {
        paths: [<rect key="p" x={4.5} y={4.5} width={15} height={15} rx={3} />],
        fills: [
          <rect
            key="f"
            x={4.5}
            y={4.5}
            width={15}
            height={15}
            rx={3}
            fill="color-mix(in srgb, currentColor 6%, transparent)"
            stroke="none"
          />,
        ],
      };
    case "d8":
      return {
        paths: [<path key="p" d="M12 2.5 L21 12 L12 21.5 L3 12 Z" />],
      };
    case "d10":
    case "d%":
      return {
        paths: [
          <path key="p1" d="M12 2.5 L19.5 9.5 L12 21.5 L4.5 9.5 Z" />,
          <path key="p2" d="M4.5 9.5 H19.5" strokeOpacity={0.5} />,
        ],
      };
    case "d12":
      return {
        paths: [<path key="p" d="M12 2.5 L21 9 L17.2 20.5 L6.8 20.5 L3 9 Z" />],
      };
    case "d20":
      return {
        paths: [
          <path key="p1" d="M12 2 L20.5 7 L20.5 17 L12 22 L3.5 17 L3.5 7 Z" />,
          <path key="p2" d="M12 7.5 L16.5 15 L7.5 15 Z" strokeOpacity={0.45} />,
        ],
      };
  }
}

export function extremityTone(face: number, sides: number): "default" | "max" | "min" {
  if (face === sides) return "max";
  if (face === 1) return "min";
  return "default";
}

function getSides(shape: DiceFaceShape): number {
  if (shape === "d%") return 100;
  return parseInt(shape.slice(1), 10);
}

const SIZE_MAP = {
  xs: 16,
  sm: 20,
  md: 28,
};

export interface DiceFaceProps {
  faceShape: DiceFaceShape;
  value: number;
  size: "xs" | "sm" | "md";
  tone?: "default" | "max" | "min";
}

export function DiceFace({ faceShape, value, size, tone }: DiceFaceProps) {
  const { t } = useTranslation();
  const sides = getSides(faceShape);
  const finalTone = tone ?? extremityTone(value, sides);
  const pxSize = SIZE_MAP[size];

  let stroke = "var(--t2)";
  let textFill = "var(--t1)";
  let washFill = "none";

  if (finalTone === "max") {
    stroke = "var(--success-text)";
    textFill = "var(--success-text)";
    washFill = "var(--success-dim)";
  } else if (finalTone === "min") {
    stroke = "var(--danger-text)";
    textFill = "var(--danger-text)";
    washFill = "var(--danger-dim)";
  }

  const glyph = glyphFor(faceShape);
  const is3Digits = value >= 100;
  const fontSize = is3Digits ? 6.5 : 9;

  let label: string = t("dice_face_showing", { shape: faceShape.slice(1), value: String(value) });
  if (faceShape === "d%") {
    label = `${t("dice_die_percentile")} ${value}`;
  }

  return (
    <svg
      width={pxSize}
      height={pxSize}
      viewBox="0 0 24 24"
      stroke={stroke}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill={washFill}
      aria-label={label}
      role="listitem"
      style={{ overflow: "visible" }}
    >
      {glyph.fills}
      {glyph.paths}
      <text
        x="12"
        y={12 + (glyph.valueDy ?? 0)}
        fill={textFill}
        stroke="none"
        fontSize={fontSize}
        fontFamily="var(--font-mono)"
        textAnchor="middle"
        dominantBaseline="central"
        className="tabular-nums"
      >
        {value}
      </text>
      {faceShape === "d%" && (
        <text
          x="19"
          y="19"
          fill={stroke}
          stroke="none"
          fontSize={7}
          fontFamily="var(--font-mono)"
          textAnchor="middle"
          dominantBaseline="central"
        >
          %
        </text>
      )}
    </svg>
  );
}

export interface DiceFacesProps {
  faceShape: DiceFaceShape;
  faces?: number[];
  attempts?: DiceAttempt[];
  notation: string;
  size: "xs" | "sm" | "md";
  maxVisible: number;
  rollKey: string;
  excluded?: boolean;
  onOverflowClick?: () => void;
  loading?: { count: number };
}

export function DiceFaces({
  faceShape,
  faces,
  attempts,
  notation,
  size,
  maxVisible,
  rollKey,
  excluded,
  onOverflowClick,
  loading,
}: DiceFacesProps) {
  const { t } = useTranslation();
  const seenIds = useRef<Set<string>>(new Set());
  
  // Extract face values
  const allFaces = faces ?? (attempts ? attempts.flatMap((a) => a.faces) : []);
  const visibleFaces = allFaces.slice(0, maxVisible);
  const overflowCount = Math.max(0, allFaces.length - maxVisible);

  // Animation check
  const isReducedMotion = window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  const isNew = !seenIds.current.has(rollKey);
  const animateClass = isNew && !isReducedMotion ? "dice-settle" : "";

  useEffect(() => {
    if (isNew) {
      seenIds.current.add(rollKey);
    }
  }, [isNew, rollKey]);

  const enumeration = `${notation}: ${allFaces.join(", ")}`;
  
  const rowClasses = `flex flex-wrap items-center gap-1.5 ${excluded ? "opacity-40" : ""}`;

  if (loading) {
    return (
      <div className={rowClasses} role="list" aria-label={t("dice_loading")}>
        {Array.from({ length: loading.count }).map((_, i) => {
          const glyph = glyphFor(faceShape);
          const pxSize = SIZE_MAP[size];
          return (
            <svg
              key={i}
              width={pxSize}
              height={pxSize}
              viewBox="0 0 24 24"
              stroke="var(--t3)"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              style={{ animation: "genp 1.3s ease-in-out infinite", opacity: 0.4 }}
              role="listitem"
              aria-label={t("dice_loading")}
            >
              {glyph.fills}
              {glyph.paths}
            </svg>
          );
        })}
      </div>
    );
  }

  return (
    <div className={rowClasses} role="list" aria-label={t("dice_faces_enumeration", { notation, faces: allFaces.join(", ") })}>
      <span className="sr-only">{t("dice_faces_enumeration", { notation, faces: allFaces.join(", ") })}</span>
      {visibleFaces.map((faceValue, i) => (
        <div 
          key={i} 
          className={animateClass} 
          style={animateClass ? { animationDelay: `${i * 55}ms` } : undefined}
        >
          <DiceFace faceShape={faceShape} value={faceValue} size={size} />
        </div>
      ))}
      {overflowCount > 0 && (
        onOverflowClick ? (
          <button className="build-tag hover:opacity-80 transition-opacity" onClick={onOverflowClick} type="button">
            {t("dice_overflow_more", { n: overflowCount })}
          </button>
        ) : (
          <span className="build-tag">
            {t("dice_overflow_more", { n: overflowCount })}
          </span>
        )
      )}
    </div>
  );
}
