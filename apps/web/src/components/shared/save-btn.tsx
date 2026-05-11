import type { FC, CSSProperties } from "react";
import { Icons } from "./icons.js";

type SaveState = "idle" | "saving" | "saved" | "error";
import { useT } from "../../i18n/context.js";

interface SaveBtnProps {
  dirty: boolean;
  saveState: SaveState;
  onClick: () => void;
  label?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

export const SaveBtn: FC<SaveBtnProps> = ({ dirty, saveState, onClick, label, style, disabled = false }) => {
  const { t } = useT();
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
        <span className="flex items-center gap-1.5">
          <span className="gen-cur inline-flex"><span /><span /><span /></span>
          {t("saving")}
        </span>
      ) : isSaved ? (
        <span className="flex items-center gap-[5px]"><Icons.Check /> {t("saved")}</span>
      ) : (
        label || t("save")
      )}
    </button>
  );
};
