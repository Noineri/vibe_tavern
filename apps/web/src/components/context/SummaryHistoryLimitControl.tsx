import type { ReactNode } from "react";
import { NumberInput } from "../shared/NumberInput.js";
import { Slider } from "../shared/slider.js";
import { Toggle } from "../shared/Toggle.js";

export function SummaryHistoryLimitControl(input: {
	readonly label: string;
	readonly autoLabel: string;
	readonly autoHint: string;
	readonly messageCount: number;
	readonly value: number;
	readonly latched: boolean;
	readonly onValueChange: (value: number) => void;
	readonly onValueCommitted: (value: number) => void;
	readonly onAutoChange: () => void;
}): ReactNode {
	const max = Math.max(1, input.messageCount);
	return (
		<div className="flex items-center gap-3">
			<Slider
				className="flex-1"
				min={1}
				max={max}
				step={1}
				value={input.value}
				onValueChange={input.onValueChange}
				onValueCommitted={input.onValueCommitted}
				aria-label={input.label}
			/>
			<NumberInput
				className="w-[80px] shrink-0"
				inputClassName="text-center"
				hideControls
				min={1}
				max={max}
				value={input.value}
				onChange={input.onValueCommitted}
			/>
			<div className="flex shrink-0 items-center gap-1.5" title={input.autoHint}>
				<Toggle checked={input.latched} onChange={input.onAutoChange} aria-label={input.autoLabel} />
				<span className="font-ui text-[11px] text-t3">{input.autoLabel}</span>
			</div>
		</div>
	);
}
