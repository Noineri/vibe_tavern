/**
 * Vite plugin: data-component
 *
 * Adds `data-component="ComponentName"` to the root JSX element of every
 * React component in development mode. Shows up in the browser's Elements
 * panel for easy debugging.
 *
 * Production builds are unaffected (plugin disables itself via configResolved).
 */

import type { Plugin } from "vite";
import { transformDataComponent } from "./data-component-transform.js";

export function dataComponentPlugin(): Plugin {
	let enabled = false;

	return {
		name: "vite-plugin-data-component",
		enforce: "pre",

		configResolved(config) {
			enabled = config.command === "serve";
		},

		transform(code: string, id: string) {
			return transformDataComponent(code, id, enabled);
		},
	};
}
