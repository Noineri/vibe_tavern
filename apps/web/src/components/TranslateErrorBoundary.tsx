import { Component, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	fallback?: ReactNode;
}

interface State {
	hasError: boolean;
}

/**
 * Error boundary that catches DOM reconciliation errors caused by
 * Chrome's auto-translate wrapping text nodes in <font> elements.
 *
 * Instead of crashing the entire page, it recovers by re-mounting
 * the children (which re-renders from React's virtual DOM, bypassing
 * the corrupted real DOM).
 */
export class TranslateErrorBoundary extends Component<Props, State> {
	constructor(props: Props) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError(): State {
		return { hasError: true };
	}

	componentDidCatch(error: Error): void {
		// Only catch DOM reconciliation errors (Chrome auto-translate)
		const isDomError =
			error.message?.includes("insertBefore") ||
			error.message?.includes("removeChild") ||
			error.message?.includes("not a child of this node");

		if (!isDomError) {
			// Re-throw non-translate errors
			throw error;
		}

		// Auto-recover: reset state to re-render children from scratch
		requestAnimationFrame(() => {
			this.setState({ hasError: false });
		});
	}

	render(): ReactNode {
		if (this.state.hasError) {
			return this.props.fallback ?? null;
		}
		return this.props.children;
	}
}
