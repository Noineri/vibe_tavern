import type { FC, CSSProperties } from "react";
import type { SaveState } from "./use-dirty-state.js";
import { Icons } from "./icons.js";

interface SaveBtnProps {
  dirty: boolean;
  saveState: SaveState;
  onClick: () => void;
  label?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

export const SaveBtn: FC<SaveBtnProps> = ({ dirty, saveState, onClick, label = "Save", style, disabled = false }) => {
  const isSaving = saveState === "saving";
  const isSaved = saveState === "saved";

  return (
    <button
      className={`api-save-btn${isSaved ? " save-btn-saved" : ""}${isSaving ? " save-btn-saving" : ""}`}
      disabled={disabled || (!dirty && !isSaved) || isSaving}
      onClick={onClick}
      style={style}
    >
      {isSaving ? (
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="gen-cur" style={{ display: "inline-flex" }}><span /><span /><span /></span>
          Saving…
        </span>
      ) : isSaved ? (
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Icons.Check /> Saved</span>
      ) : (
        label
      )}
    </button>
  );
};
