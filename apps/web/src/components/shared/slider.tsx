import { SliderFieldAppearance } from "./slider-field-appearance.js";
import { SliderRail } from "./slider-rail.js";

export type SliderValue = number | [number, number];
export type SliderSize = "md" | "sm" | "xs";
export type SliderOrientation = "horizontal" | "vertical";

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
	appearance?: "rail" | "field";
	/** Formats the complete controlled value, including a two-thumb tuple. */
	formatValue?: (value: Value) => string;
	/** Field-only value classes; replaces the default text-t1 color. */
	valueClassName?: string;
	label?: React.ReactNode;
	help?: React.ReactNode;
	/** Test id(s) assigned to Base UI's nested range input(s), never the visual wrapper. */
	inputTestId?: string | [string, string];
	/** Test id assigned to the field appearance's inline number editor. */
	numberTestId?: string;
	"aria-label"?: string;
	getAriaLabel?: (index: number) => string;
	className?: string;
}

export function Slider<Value extends SliderValue>(props: SliderProps<Value>) {
	if (props.appearance === "field") return <SliderFieldAppearance {...props} />;
	return <SliderRail {...props} />;
}
