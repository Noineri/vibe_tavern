/**
 * Collapsible slot-category legend for the prompt-order canvas (APC-3c).
 *
 * Rendered once at the top of the canvas (below the title, above the zones) so a
 * glance at the five header icons (APC-3a registry) maps to what each row
 * injects. Collapsed by default — a `?` toggle reveals a compact grid. The
 * legend reads category → icon from the SAME registry the cards do, so the two
 * can never drift apart.
 */
import { useState } from "react";
import { useT } from "../../../i18n/context.js";
import { cn } from "../../../lib/cn.js";
import { Ic } from "../../shared/icons.js";
import { SLOT_CATEGORY_ICON, type SlotCategory } from "./canvas-icons.js";

/** Display order (most-authored → least): standard, character, persona, anchor, custom. */
const LEGEND_ORDER: readonly SlotCategory[] = ["standard", "character", "persona", "anchor", "custom"];

export function CanvasLegend() {
	const { t, tDynamic } = useT();
	const [open, setOpen] = useState(false);

	return (
		<div className="mb-3">
			<button
				type="button"
				className="flex items-center gap-1 font-ui text-[11px] text-t4 transition-colors hover:text-t2"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-label={t("cc_legend_toggle")}
			>
				<span className="flex h-[13px] w-[13px] items-center justify-center" aria-hidden="true"><Ic.help /></span>
				<span>{t("cc_legend_toggle")}</span>
				<span className={cn("text-[10px] transition-transform", open && "rotate-90")} aria-hidden="true">▶</span>
			</button>
			{open && (
				<div className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-md border border-border2 bg-s2/40 p-2.5 sm:grid-cols-2">
					{LEGEND_ORDER.map((cat) => {
						const Icon = SLOT_CATEGORY_ICON[cat];
						return (
							<div key={cat} className="min-w-0">
								<div className="flex items-center gap-2">
									<span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center text-t3" aria-hidden="true"><Icon /></span>
									<span className="font-ui text-[11px] font-medium text-t2">{tDynamic(`cc_legend_${cat}`)}</span>
								</div>
								<span className="mt-0.5 block pl-[21px] font-ui text-[10px] leading-tight text-t4">{tDynamic(`cc_legend_${cat}_desc`)}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
