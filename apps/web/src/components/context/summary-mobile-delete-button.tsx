import { Icons } from "../shared/icons.js";
import { CustomTooltip } from "../shared/Tooltip.js";

export function SummaryMobileDeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <CustomTooltip content={label}>
      <button type="button"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-danger-dim text-danger-text hover:bg-danger hover:text-on-danger transition-colors md:hidden"
        onClick={onClick}
        aria-label={label}
      >
        <Icons.Trash />
      </button>
    </CustomTooltip>
  );
}
