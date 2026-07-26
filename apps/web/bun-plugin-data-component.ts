import type { BunPlugin } from "bun";
import { transformDataComponent } from "./data-component-transform.js";

export function bunDataComponentPlugin(): BunPlugin {
	return {
		name: "bun-plugin-data-component",
		setup(builder) {
			builder.onLoad({ filter: /\.[tj]sx$/ }, async (args) => {
				const input = await Bun.file(args.path).text();
				const output = transformDataComponent(input, args.path, true);
				if (output === null) return undefined;
				return { contents: output, loader: args.loader };
			});
		},
	};
}

export default bunDataComponentPlugin();
