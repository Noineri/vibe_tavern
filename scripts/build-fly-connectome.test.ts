import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
	buildConnectome,
	classifyNeuron,
	generateFixtureCsv,
	parseCsvLine,
	type BuildOptions,
	type FlyBrainManifest,
	FORMAT_VERSION,
	MAGIC,
} from "./build-fly-connectome.js";

const repoRoot = resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
	const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(path, { recursive: true });
	temporaryDirectories.push(path);
	return path;
}

const fixtureOptions: BuildOptions = {
	gfTypes: [],
	stamp: "1970-01-01T00:00:00.000Z",
	source: { dataset: "mcns-test", version: "0", access: "fixture", license: "CC-BY-4.0", attribution: "fixture" },
};

async function writeFixtureCsv(dir: string): Promise<void> {
	const fixture = generateFixtureCsv();
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "cell_types.csv"), fixture.cellTypes);
	await writeFile(join(dir, "connections.csv"), fixture.connections);
}

interface DecodedBinary {
	neuronCount: number;
	edgeCount: number;
	groupCount: number;
	typeCount: number;
	edges: { pre: number; post: number; weight: number }[];
	neurons: { region: number; group: number; type: number }[];
}

function decodeBinary(gz: Uint8Array): DecodedBinary {
	const raw = gunzipSync(Buffer.from(gz));
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	expect(view.getUint32(0, true)).toBe(MAGIC);
	expect(view.getUint16(4, true)).toBe(FORMAT_VERSION);
	const neuronCount = view.getUint32(8, true);
	const edgeCount = view.getUint32(12, true);
	const groupCount = view.getUint32(16, true);
	const typeCount = view.getUint32(20, true);
	const edges: { pre: number; post: number; weight: number }[] = [];
	let offset = 24;
	for (let i = 0; i < edgeCount; i++) {
		edges.push({ pre: view.getUint32(offset, true), post: view.getUint32(offset + 4, true), weight: view.getFloat32(offset + 8, true) });
		offset += 12;
	}
	const neurons: { region: number; group: number; type: number }[] = [];
	for (let i = 0; i < neuronCount; i++) {
		neurons.push({ region: view.getUint8(offset), group: view.getUint16(offset + 1, true), type: view.getUint16(offset + 3, true) });
		offset += 5;
	}
	return { neuronCount, edgeCount, groupCount, typeCount, edges, neurons };
}

test("parseCsvLine handles quoting, escaped quotes and commas inside fields", () => {
	expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
	expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
	expect(parseCsvLine('"say ""hi""",x')).toEqual(['say "hi"', "x"]);
	expect(parseCsvLine("")).toEqual([""]);
});

test("classifyNeuron maps Codex classes onto circuit groups with PPL1/PAM split and GF flourish", () => {
	expect(classifyNeuron({ cls: "olfactory", cellType: "Or42b", resolvedType: "" }, [])).toBe("OLF_OS");
	expect(classifyNeuron({ cls: "ol_bilateral", cellType: "Or2a", resolvedType: "" }, [])).toBe("OLF_OS");
	expect(classifyNeuron({ cls: "alpn", cellType: "M_vPN", resolvedType: "" }, [])).toBe("OLF_PN");
	expect(classifyNeuron({ cls: "alon", cellType: "PN", resolvedType: "" }, [])).toBe("OLF_PN");
	expect(classifyNeuron({ cls: "alln", cellType: "LN", resolvedType: "" }, [])).toBe("OLF_LN");
	expect(classifyNeuron({ cls: "kenyon_cell", cellType: "KC_g", resolvedType: "" }, [])).toBe("KC");
	expect(classifyNeuron({ cls: "mbon", cellType: "MBON_01", resolvedType: "" }, [])).toBe("MBON");
	expect(classifyNeuron({ cls: "dan", cellType: "PPL1-g1ped", resolvedType: "" }, [])).toBe("DAN_PPL1");
	expect(classifyNeuron({ cls: "dan", cellType: "PAM-b2", resolvedType: "" }, [])).toBe("DAN_PAM");
	expect(classifyNeuron({ cls: "dan", cellType: "PPL2-a1", resolvedType: "" }, [])).toBe("DAN_OTHER");
	expect(classifyNeuron({ cls: "descending_neuron", cellType: "giant fiber", resolvedType: "" }, [])).toBe("GF");
	expect(classifyNeuron({ cls: "dn", cellType: "", resolvedType: "Giant Fiber" }, [])).toBe("GF");
	expect(classifyNeuron({ cls: "cx", cellType: "EPG", resolvedType: "" }, [])).toBe("OTHER");
	// MBIN (MB input neuron) resolves its cluster from resolved_type when cell_type is empty.
	expect(classifyNeuron({ cls: "mbin", cellType: "", resolvedType: "PAM-a1" }, [])).toBe("DAN_PAM");
	// Explicit --gf-types entries win before class rules.
	expect(classifyNeuron({ cls: "descending_neuron", cellType: "DNa01", resolvedType: "" }, ["dna01"])).toBe("GF");
});

test("fixture pipeline: counts, groups, aggregation, NT signs, unknown endpoints", async () => {
	const dir = await tempRoot("fly-ft1-e2e-");
	await writeFixtureCsv(dir);
	const { binaryGz, manifest, report } = await buildConnectome(join(dir, "cell_types.csv"), join(dir, "connections.csv"), fixtureOptions);

	// 122 wired cells + 1 isolated BigInt-id neuron + 3 unknown connection endpoints.
	expect(report.neurons).toBe(126);
	expect(report.unknownEndpoints).toBe(3);
	expect(report.edges).toBe(155);
	expect(report.countsByGroup).toEqual({
		OLF_OS: 20,
		OLF_PN: 10,
		OLF_LN: 6,
		KC: 60,
		MBON: 8,
		DAN_PPL1: 3,
		DAN_PAM: 2,
		DAN_OTHER: 1,
		GF: 2,
		OTHER: 14,
	});

	const decoded = decodeBinary(binaryGz);
	expect(decoded.groupCount).toBe(10);
	expect(manifest.binary.neuronCount).toBe(decoded.neuronCount);
	expect(manifest.binary.edgeCount).toBe(decoded.edgeCount);
	expect(manifest.binary.sizeBytes).toBe(binaryGz.byteLength);
	expect(manifest.binary.sha256).toBe(createHash("sha256").update(binaryGz).digest("hex"));

	// Reconstruct the canonical neuron order (BigInt ascending) to address edges.
	const idOf = (n: number): string => String(1000000000n + BigInt(n) * 37n);
	const ids = [
		...Array.from({ length: 122 }, (_, i) => idOf(i)),
		idOf(40000),
		idOf(40001),
		idOf(40002),
		"720575940630000001",
	].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
	const index = new Map(ids.map((id, i) => [id, i]));
	const weightOf = (pre: number, post: number): number => {
		const edge = decoded.edges.find((candidate) => candidate.pre === pre && candidate.post === post);
		expect(edge).toBeDefined();
		return edge?.weight ?? 0;
	};

	// PPL1→KC pair summed across two neuropils: 10 + 6 = 16 (DA is excitatory).
	expect(weightOf(index.get(idOf(104)) ?? -1, index.get(idOf(37)) ?? -1)).toBe(16);
	// LN→PN carries the GABA sign.
	expect(weightOf(index.get(idOf(30)) ?? -1, index.get(idOf(20)) ?? -1)).toBe(-8);
	// Empty row NT falls back to the pre-neuron NT (cx spec = ACH → +).
	expect(weightOf(index.get(idOf(112)) ?? -1, index.get(idOf(99)) ?? -1)).toBe(4);
	// Unknown NT defaults to +1 and is reported.
	expect(report.unknownNtRows).toBe(1);
	expect(weightOf(index.get(idOf(40001)) ?? -1, index.get(idOf(40002)) ?? -1)).toBe(3);

	// The 19-digit id sorts after every 10-digit id under BigInt ordering.
	const lastNeuron = decoded.neurons[decoded.neurons.length - 1];
	const lastType = manifest.types[lastNeuron.type];
	expect(lastType).toBe("EPG_extra");
	// Unknown endpoints land in OTHER with the empty type.
	const firstUnknown = decoded.neurons[index.get(idOf(40000)) ?? -1];
	expect(firstUnknown.group).toBe(9);
	expect(manifest.types[firstUnknown.type]).toBe("");
});

test("fixture build is byte-deterministic across runs", async () => {
	const dir = await tempRoot("fly-ft1-det-");
	await writeFixtureCsv(dir);
	const first = await buildConnectome(join(dir, "cell_types.csv"), join(dir, "connections.csv"), fixtureOptions);
	const second = await buildConnectome(join(dir, "cell_types.csv"), join(dir, "connections.csv"), fixtureOptions);
	expect(Buffer.compare(Buffer.from(first.binaryGz), Buffer.from(second.binaryGz))).toBe(0);
	expect(JSON.stringify(first.manifest)).toBe(JSON.stringify(second.manifest));
});

test("MCNS UI export aliases map: verified NT beats predicted, ol_bilateral is OSN, empty row NT falls back to pre-neuron", async () => {
	const dir = await tempRoot("fly-ft1-alias-");
	await writeFile(
		join(dir, "neurons.csv"),
		[
			"Root ID,Top in/out region,Community labels,Predicted NT type,Predicted NT confidence,Verified NT type,Verified Neuropeptide,Body Part,Function,Flow,Super Class,Class,Sub Class,Hemilineage,Nerve,Soma side,Primary Cell Type,Alternative Cell Type(s)",
			"1,g1,,ACH,0.9,,,,,,,olfactory,,putative_primary,,left,Or1a,",
			"2,g2,,GABA,0.8,,,,,,,ol_bilateral,,,,right,Or2a,",
			"3,g3,,DA,0.7,,,,,,,dan,,,,left,PAM01,",
		].join("\n") + "\n",
	);
	await writeFile(
		join(dir, "connections_princeton.csv"),
		["pre_root_id,post_root_id,neuropil,syn_count,nt_type", "1,3,MB_CA,4,"].join("\n") + "\n",
	);
	const { binaryGz, manifest, report } = await buildConnectome(join(dir, "neurons.csv"), join(dir, "connections_princeton.csv"), fixtureOptions);
	expect(report.neurons).toBe(3);
	expect(report.countsByGroup).toEqual({
		OLF_OS: 2,
		OLF_PN: 0,
		OLF_LN: 0,
		KC: 0,
		MBON: 0,
		DAN_PPL1: 0,
		DAN_PAM: 1,
		DAN_OTHER: 0,
		GF: 0,
		OTHER: 0,
	});
	const decoded = decodeBinary(binaryGz);
	expect(decoded.edgeCount).toBe(1);
	// Row NT is empty → pre-neuron NT: verified column empty → predicted ACH → +4.
	expect(decoded.edges[0].weight).toBe(4);
	expect(manifest.types[decoded.neurons[0].type]).toBe("Or1a");
});

test("CLI --fixture mode writes binary + manifest with matching counts (no network)", async () => {
	const out = await tempRoot("fly-ft1-cli-");
	const child = Bun.spawn(["bun", join(repoRoot, "scripts", "build-fly-connectome.ts"), "--fixture", out], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(existsSync(join(out, "connectome.bin.gz"))).toBe(true);
	const manifest = JSON.parse(readFileSync(join(out, "fly-brain-manifest.json"), "utf8")) as FlyBrainManifest;
	expect(manifest.binary.neuronCount).toBe(126);
	expect(manifest.generatedAt).toBe("1970-01-01T00:00:00.000Z");
	expect(manifest.source.dataset).toBe("mcns");
	expect(existsSync(join(out, "_fixture-src", "cell_types.csv"))).toBe(true);
});
