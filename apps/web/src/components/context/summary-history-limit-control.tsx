import type { ReactNode } from "react";
import { SliderField } from "../shared/SliderField.js";
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
		<div className="flex min-w-0 flex-1 items-center gap-3">
			<div className="min-w-0 flex-1">
				<SliderField
					label={input.label}
					min={1}
					max={max}
					step={1}
					value={input.value}
					onChange={(value) => input.onValueChange(Math.round(value))}
					onCommit={(value) => input.onValueCommitted(Math.round(value))}
				/>
			</div>
			<div className="flex shrink-0 items-center gap-1.5" title={input.autoHint}>
				<Toggle checked={input.latched} onChange={input.onAutoChange} aria-label={input.autoLabel} />
				<span className="font-ui text-[calc(var(--ui-fs)-3px)] text-t3">{input.autoLabel}</span>
			</div>
		</div>
	);
}
