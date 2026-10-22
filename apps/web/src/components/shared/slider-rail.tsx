import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "../../lib/cn.js";
import type { SliderOrientation, SliderProps, SliderSize, SliderValue } from "./slider.js";

const sizeClasses: Record<SliderSize, { horizontalTrack: string; verticalTrack: string; thumb: string; horizontalRoot: string; verticalRoot: string }> = {
	md: { horizontalTrack: "h-[6px]", verticalTrack: "w-[6px]", thumb: "h-[18px] w-[18px] border-[3px]", horizontalRoot: "h-[18px]", verticalRoot: "w-[18px]" },
	sm: { horizontalTrack: "h-1", verticalTrack: "w-1", thumb: "h-[14px] w-[14px] border-2", horizontalRoot: "h-[14px]", verticalRoot: "w-[14px]" },
	xs: { horizontalTrack: "h-[3px]", verticalTrack: "w-[3px]", thumb: "h-3 w-3 border-2", horizontalRoot: "h-3", verticalRoot: "w-3" },
};

function toSliderValue(value: number | readonly number[]): SliderValue {
	return typeof value === "number" ? value : [value[0]!, value[1]!];
}

function inputTestIdAt(inputTestId: SliderProps["inputTestId"], index: number) {
	return typeof inputTestId === "string" ? inputTestId : inputTestId?.[index];
}

export function SliderRail<Value extends SliderValue>({
	value, min, max, step, onValueChange, onValueCommitted, disabled = false, size = "md", orientation = "horizontal",
	formatValue, "aria-label": ariaLabel, getAriaLabel, inputTestId, className,
}: SliderProps<Value>) {
	const range = Array.isArray(value);
	const dimensions = sizeClasses[size];

	return (
		<BaseSlider.Root
			data-slider-root value={value} min={min} max={max} step={step} disabled={disabled} orientation={orientation}
			thumbCollisionBehavior={range ? "none" : undefined}
			onValueChange={(next) => { if (!disabled) onValueChange(toSliderValue(next) as Value); }}
			onValueCommitted={onValueCommitted ? (next) => { if (!disabled) onValueCommitted(toSliderValue(next) as Value); } : undefined}
			className={cn("group relative touch-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40", orientation === "horizontal" ? "w-full [@media(pointer:coarse)]:h-11" : "h-full min-h-11 [@media(pointer:coarse)]:w-11", orientation === "horizontal" ? dimensions.horizontalRoot : dimensions.verticalRoot, className)}
		>
			<BaseSlider.Control className={cn("relative flex h-full w-full touch-none select-none", orientation === "horizontal" ? "items-center" : "justify-center")}>
				<BaseSlider.Track data-slider-track className={cn("relative overflow-visible rounded-full bg-s3", orientation === "horizontal" ? "w-full" : "h-full", orientation === "horizontal" ? dimensions.horizontalTrack : dimensions.verticalTrack)}>
					<BaseSlider.Indicator className={cn("rounded-full bg-[linear-gradient(to_right,var(--accent-mid),var(--accent))]", orientation === "vertical" && "bg-[linear-gradient(to_top,var(--accent-mid),var(--accent))]")} />
				</BaseSlider.Track>
				{[0, ...(range ? [1] : [])].map((index) => {
					const testId = inputTestIdAt(inputTestId, index);
					return (
						<BaseSlider.Thumb
							key={index}
							index={range ? index : undefined}
							aria-label={range ? undefined : ariaLabel}
							getAriaLabel={range ? getAriaLabel : undefined}
							inputRef={(input) => { if (input && testId) input.dataset.testid = testId; }}
							data-slider-thumb
							className={cn(
								"group/thumb rounded-full border-accent bg-[color-mix(in_oklch,white_88%,var(--accent))] transition-[transform,box-shadow] duration-100 hover:scale-[1.1] data-[dragging]:scale-[1.1] hover:shadow-[0_0_0_6px_color-mix(in_oklch,var(--accent)_18%,transparent)] has-[input:focus-visible]:shadow-[0_0_0_6px_color-mix(in_oklch,var(--accent)_18%,transparent)]",
								dimensions.thumb,
							)}
						>
							{formatValue && (
								<output
									data-slider-bubble
									className={cn(
										"pointer-events-none absolute z-10 hidden whitespace-nowrap rounded-[5px] bg-accent px-1.5 py-px font-ui text-[calc(var(--ui-fs)-3px)] font-medium text-on-accent tabular-nums data-[dragging]:block has-[input:focus-visible]:block",
										orientation === "horizontal" ? "bottom-[calc(100%+4px)] left-1/2 -translate-x-1/2" : "left-[calc(100%+8px)] top-1/2 -translate-y-1/2",
									)}
								>
									{formatValue(value)}
								</output>
							)}
						</BaseSlider.Thumb>
					);
				})}
			</BaseSlider.Control>
		</BaseSlider.Root>
	);
}
