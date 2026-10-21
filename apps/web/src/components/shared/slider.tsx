import { Slider as BaseSlider } from "@base-ui/react/slider";
import { cn } from "../../lib/cn.js";

type SliderValue = number | [number, number];
type SliderSize = "md" | "sm" | "xs";
type SliderOrientation = "horizontal" | "vertical";

export interface SliderProps<Value extends SliderValue = SliderValue> {
	value: Value;
	min: number;
	max: number;
	step: number;
	onValueChange: (value: Value) => void;
	onValueCommitted?: (value: Value) => void;
	disabled?: boolean;
	size?: SliderSize;
	orientation?: SliderOrientation;
	"aria-label"?: string;
	getAriaLabel?: (index: number) => string;
	/** Test id(s) assigned to Base UI's nested range input(s), never the visual wrapper. */
	inputTestId?: string | [string, string];
	className?: string;
}

const sizeClasses: Record<SliderSize, { track: string; thumb: string }> = {
	md: { track: "h-1", thumb: "h-[14px] w-[14px]" },
	sm: { track: "h-1", thumb: "h-3 w-3" },
	xs: { track: "h-[3px]", thumb: "h-2.5 w-2.5" },
};

function toSliderValue(value: number | readonly number[]): SliderValue {
	if (typeof value === "number") return value;
	return [value[0]!, value[1]!];
}

function inputTestIdAt(inputTestId: SliderProps["inputTestId"], index: number): string | undefined {
	return typeof inputTestId === "string" ? inputTestId : inputTestId?.[index];
}

export function Slider<Value extends SliderValue>({
	value,
	min,
	max,
	step,
	onValueChange,
	onValueCommitted,
	disabled = false,
	size = "md",
	orientation = "horizontal",
	"aria-label": ariaLabel,
	getAriaLabel,
	inputTestId,
	className,
}: SliderProps<Value>) {
	const range = Array.isArray(value);
	const dimensions = sizeClasses[size];

	function renderThumb(index: number) {
		const testId = inputTestIdAt(inputTestId, index);
		return (
			<BaseSlider.Thumb
				key={index}
				index={range ? index : undefined}
				aria-label={range ? undefined : ariaLabel}
				getAriaLabel={range ? getAriaLabel : undefined}
				inputRef={(input) => {
					if (input && testId) input.dataset.testid = testId;
				}}
				data-slider-thumb
				className={cn(
					"group/thumb rounded-full border-2 border-surface bg-accent transition-transform duration-100",
					"hover:scale-[1.15] data-[dragging]:scale-[1.15] group-data-[focused]:ring-4 group-data-[focused]:ring-accent/35",
					dimensions.thumb,
				)}
			/>
		);
	}

	return (
		<BaseSlider.Root
			data-slider-root
			value={value}
			min={min}
			max={max}
			step={step}
			disabled={disabled}
			orientation={orientation}
			thumbCollisionBehavior={range ? "none" : undefined}
			onValueChange={(nextValue) => {
				if (!disabled) onValueChange(toSliderValue(nextValue) as Value);
			}}
			onValueCommitted={onValueCommitted ? (nextValue) => {
				if (!disabled) onValueCommitted(toSliderValue(nextValue) as Value);
			} : undefined}
			className={cn(
				"group relative touch-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
				orientation === "horizontal" ? "h-11 w-full" : "h-full min-h-11 w-11",
				className,
			)}
		>
			<BaseSlider.Control
				className={cn(
					"relative flex h-full w-full touch-none select-none",
					orientation === "horizontal" ? "items-center" : "justify-center",
				)}
			>
				<BaseSlider.Track
					className={cn(
						"relative overflow-hidden rounded-full bg-s3",
						orientation === "horizontal" ? `w-full ${dimensions.track}` : `h-full ${dimensions.track.replace("h-", "w-")}`,
					)}
				>
					<BaseSlider.Indicator className="rounded-full bg-accent" />
				</BaseSlider.Track>
				{renderThumb(0)}
				{range && renderThumb(1)}
			</BaseSlider.Control>
		</BaseSlider.Root>
	);
}
