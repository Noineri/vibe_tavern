/**
 * Fly Tribunal — connectome build pipeline (Wave 1 / FT-1).
 *
 * Ported and extended from snedea/flybrain `scripts/build_connectome.py` (MIT):
 * https://github.com/snedea/flybrain — same numeric binary layout philosophy
 * (counts header, NT-signed aggregated edges, per-neuron typing bytes), reworked:
 * - input contract is the Codex static export pair (typed cells + connections);
 * - per-neuron record gains a `u16 type id` (index into the manifest type table)
 *   so PPL1/PAM DAN clusters and per-compartment MBON typing survive the binary;
 * - group table is our learning-circuit grouping, not snedea's 63 groups;
 * - all string metadata lives in `fly-brain-manifest.json`, the binary is pure numbers.
 *
 * Usage:
 *   bun scripts/build-fly-connectome.ts --data-dir <dir> [--out services/api/assets/fly]
 *        [--gf-types "giant fiber,DNa01"] [--dataset mcns] [--dataset-version 1.0]
 *        [--stamp <iso>] [--expected-neurons N] [--expected-connections N]
 *   bun scripts/build-fly-connectome.ts --fixture <out-dir> [--gf-types ...]
 *
 * Input contract (`--data-dir`, `.csv` or `.csv.gz`, either naming — both the
 * Codex API export layout and the Codex UI "Download Data" MCNS layout work,
 * see COLUMN_ALIASES):
 *   cell_types.csv / neurons.csv — typed cell table: root_id, super_class,
 *                      class, sub_class, cell_type, resolved_type, nt_type, side, flow
 *                      (aliases: Root ID / Super Class / Class / Sub Class /
 *                      Primary Cell Type / Alternative Cell Type(s) /
 *                      Verified NT type → Predicted NT type / Soma side / Flow).
 *   connections.csv / connections_princeton.csv — pre_root_id, post_root_id,
 *                      syn_count, nt_type, [neuropil] (one row per pair × neuropil;
 *                      aggregated like snedea; empty row NT falls back to the
 *                      pre-neuron NT).
 *
 * Output (into `--out`, default `services/api/assets/fly/`):
 *   connectome.bin.gz      — gzipped binary, format v1 (see `MAGIC`/format below).
 *   fly-brain-manifest.json — source/license/attribution, sha256 + sizes, group and
 *                            type tables, counts, typing rules.
 *
 * Binary format v1 (all little-endian, strings only in the manifest):
 *   u32 magic "FTCB", u16 formatVersion, u16 reserved,
 *   u32 neuronCount, u32 edgeCount, u32 groupCount, u32 typeCount,
 *   edgeCount × { u32 pre, u32 post, f32 weight },
 *   neuronCount × { u8 region, u16 group, u16 type }.
 *
 * The binary carries the FULL connectome (the "you downloaded a whole brain"
 * moment); the worker instantiates only the learning-circuit subgraph by
 * filtering on group/type ids (see plan FLY_TRIBUNAL_PLAN.md, Wave 3).
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { gzipSync } from "node:zlib";

// ── Group table ─────────────────────────────────────────────────────────────
// Region codes: 0 = sensory, 1 = central, 2 = motor (u8 in the binary).
// DAN split per plan: PPL1 cluster = punitive (negative training analog),
// PAM cluster = reward (positive training analog); unclassifiable DANs keep
// their own group so nothing silently joins a cluster.

export const FLY_GROUPS = [
	{ name: "OLF_OS", region: 0 },
	{ name: "OLF_PN", region: 1 },
	{ name: "OLF_LN", region: 1 },
	{ name: "KC", region: 1 },
	{ name: "MBON", region: 1 },
	{ name: "DAN_PPL1", region: 1 },
	{ name: "DAN_PAM", region: 1 },
	{ name: "DAN_OTHER", region: 1 },
	{ name: "GF", region: 2 },
	{ name: "OTHER", region: 1 },
] as const;

export type FlyGroupId = (typeof FLY_GROUPS)[number]["name"];

const GROUP_INDEX: Readonly<Record<FlyGroupId, number>> = Object.fromEntries(
	FLY_GROUPS.map((g, i) => [g.name, i]),
) as Readonly<Record<FlyGroupId, number>>;

export const MAGIC = 0x42435446; // "FTCB" little-endian
export const FORMAT_VERSION = 1;

// NT → sign, after snedea: excitatory +1, GABA −1, unknown +1 (counted + warned).
const NT_SIGN: Readonly<Record<string, number>> = {
	ach: 1,
	glut: 1,
	da: 1,
	oa: 1,
	ser: 1,
	gaba: -1,
};
const EXCITATORY_NTS = ["ACH", "GLUT", "DA", "OA", "SER"];
const INHIBITORY_NTS = ["GABA"];

// Giant-fiber flourish detection: normalized substring patterns over the
// cell_type / resolved_type fields, plus explicit `--gf-types` entries.
// MCNS cell-type vocabulary is verified at the first real data run; the
// default pattern targets the literature name.
const GF_DEFAULT_PATTERNS = ["giantfiber"];

export interface ManifestSource {
	readonly dataset: string;
	readonly version: string;
	readonly access: string;
	readonly license: string;
	readonly attribution: string;
}

export interface FlyBrainManifest {
	format: "fly-brain-manifest/1";
	generatedAt: string;
	generator: string;
	source: ManifestSource;
	binary: {
		file: string;
		formatVersion: number;
		sha256: string;
		sizeBytes: number;
		neuronCount: number;
		edgeCount: number;
	};
	weights: {
		unit: string;
		aggregation: string;
		excitatory: string[];
		inhibitory: string[];
		unknownDefaultsTo: string;
	};
	groups: readonly { id: number; name: string; region: string }[];
	countsByGroup: Record<string, number>;
	types: string[];
	circuit: {
		danClusterRule: string;
		giantFiberTypes: string[];
	};
	notes: string[];
}

export interface BuildOptions {
	gfTypes: readonly string[];
	stamp: string;
	source: ManifestSource;
}

interface Graph {
	neuronCount: number;
	edgeCount: number;
	group: Uint8Array;
	region: Uint8Array;
	typeIndex: Uint16Array;
	edgePre: Uint32Array;
	edgePost: Uint32Array;
	edgeWeight: Float32Array;
	typeTable: string[];
	countsByGroup: Record<string, number>;
}

interface BuildReport {
	neurons: number;
	edges: number;
	unknownEndpoints: number;
	unknownNtRows: number;
	typeCount: number;
	countsByGroup: Record<string, number>;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Quote-aware CSV line splitter (Codex CSVs quote fields containing commas). */
export function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			fields.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	fields.push(current);
	return fields;
}

async function* lines(path: string): AsyncGenerator<string> {
	const stream = createReadStream(path);
	const source = path.endsWith(".gz") ? stream.pipe(createGunzip()) : stream;
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of source) {
		buffer += decoder.decode(chunk as Buffer, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.length > 0) yield line.endsWith("\r") ? line.slice(0, -1) : line;
			newline = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.trim().length > 0) {
		yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
	}
}

interface CsvTable {
	columns: ReadonlyMap<string, number>;
	ntFieldIndexes: readonly number[];
	rows: AsyncGenerator<string[]>;
}

// Canonical field name → accepted CSV header spellings (first present wins).
// Left column: this script's canonical names (fixture + tests). Right: the
// Codex UI "Download Data" MCNS export headers, verified live 2026-09-26.
const COLUMN_ALIASES: Readonly<Record<string, readonly string[]>> = {
	pre_root_id: ["pre_root_id"],
	post_root_id: ["post_root_id"],
	syn_count: ["syn_count"],
	nt_type: ["nt_type"],
	root_id: ["root_id", "Root ID"],
	super_class: ["super_class", "Super Class"],
	class: ["class", "Class"],
	sub_class: ["sub_class", "Sub Class"],
	cell_type: ["cell_type", "Primary Cell Type"],
	resolved_type: ["resolved_type", "Alternative Cell Type(s)"],
	side: ["side", "Soma side"],
	flow: ["flow", "Flow"],
};
// NT columns, first NON-EMPTY value wins: raw nt_type → Verified → Predicted.
const NT_ALIASES: readonly string[] = ["nt_type", "Verified NT type", "Predicted NT type"];

async function openCsv(path: string): Promise<CsvTable> {
	const iterator = lines(path);
	const first = await iterator.next();
	if (first.done) throw new Error(`Empty CSV file: ${path}`);
	const header = parseCsvLine(first.value).map((column) => column.trim());
	const columns = new Map<string, number>();
	for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
		for (const alias of aliases) {
			const index = header.indexOf(alias);
			if (index >= 0) {
				columns.set(canonical, index);
				break;
			}
		}
	}
	const ntFieldIndexes = NT_ALIASES.map((alias) => header.indexOf(alias)).filter((index) => index >= 0);
	async function* rows(): AsyncGenerator<string[]> {
		for await (const line of iterator) {
			if (line.trim().length === 0) continue;
			yield parseCsvLine(line);
		}
	}
	return { columns, ntFieldIndexes, rows: rows() };
}

function field(row: readonly string[], columns: ReadonlyMap<string, number>, name: string): string {
	const index = columns.get(name);
	if (index === undefined || index >= row.length) return "";
	return row[index].trim();
}

function readNt(row: readonly string[], table: CsvTable): string {
	for (const index of table.ntFieldIndexes) {
		const value = row[index]?.trim() ?? "";
		if (value !== "") return value.toUpperCase();
	}
	return "";
}

// ── Classification ──────────────────────────────────────────────────────────

export interface NeuronFields {
	readonly cls: string;
	readonly cellType: string;
	readonly resolvedType: string;
}

function normalize(s: string): string {
	return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Map Codex classification fields onto our learning-circuit groups.
 * Rules are tuned to FlyWire-family `class` values (snedea's FAFB-verified
 * vocabulary); MCNS conformance is re-verified at the first real data run —
 * the build report prints the group distribution for exactly that check.
 */
export function classifyNeuron(fields: NeuronFields, gfTypes: readonly string[]): FlyGroupId {
	const type = normalize(fields.cellType);
	const resolved = normalize(fields.resolvedType);
	const cls = normalize(fields.cls);
	const patterns = [...GF_DEFAULT_PATTERNS, ...gfTypes.map(normalize)];
	if (patterns.some((pattern) => pattern.length > 0 && (type.includes(pattern) || resolved.includes(pattern)))) {
		return "GF";
	}
	if (cls.includes("olfact") || cls === "olbilateral") return "OLF_OS";
	if (cls === "alpn" || cls === "alon") return "OLF_PN";
	if (cls === "alln" || cls === "alin") return "OLF_LN";
	if (cls.includes("kenyon") || cls === "kc") return "KC";
	if (cls === "mbon") return "MBON";
	if (cls === "dan" || cls === "mbin") {
		// Cluster split from the cell_type prefix (Aso 2014 cluster names);
		// resolved_type is the fallback source when cell_type is empty.
		const clusterType = type !== "" ? type : resolved;
		if (clusterType.startsWith("ppl1")) return "DAN_PPL1";
		if (clusterType.startsWith("pam")) return "DAN_PAM";
		return "DAN_OTHER";
	}
	return "OTHER";
}

// ── Graph build ─────────────────────────────────────────────────────────────

function compareRootIds(a: string, b: string): number {
	if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
		const bigA = BigInt(a);
		const bigB = BigInt(b);
		return bigA < bigB ? -1 : bigA > bigB ? 1 : 0;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

async function buildGraph(
	cellTypesPath: string,
	connectionsPath: string,
	options: BuildOptions,
): Promise<{ graph: Graph; report: BuildReport }> {
	// Pass 1 — typed cells: root_id → group + type string + nt (for sign fallback).
	interface CellRecord {
		group: FlyGroupId;
		type: string;
		nt: string;
	}
	const cells = new Map<string, CellRecord>();
	const cellTable = await openCsv(cellTypesPath);
	if (!cellTable.columns.has("root_id")) {
		throw new Error(`No root_id column in ${cellTypesPath}`);
	}
	for await (const row of cellTable.rows) {
		const rootId = field(row, cellTable.columns, "root_id");
		if (rootId === "") continue;
		const cellType = field(row, cellTable.columns, "cell_type");
		const resolvedType = field(row, cellTable.columns, "resolved_type");
		const cls = field(row, cellTable.columns, "class");
		cells.set(rootId, {
			group: classifyNeuron({ cls, cellType, resolvedType }, options.gfTypes),
			type: cellType !== "" ? cellType : resolvedType,
			nt: readNt(row, cellTable),
		});
	}

	// Pass 2 — connections, first sweep: endpoints missing from the cell table
	// (rare stragglers; appended as untyped OTHER so no edge is silently dropped).
	const unknownEndpoints = new Set<string>();
	{
		const table = await openCsv(connectionsPath);
		if (!table.columns.has("pre_root_id") || !table.columns.has("post_root_id")) {
			throw new Error(`Missing pre_root_id/post_root_id columns in ${connectionsPath}`);
		}
		for await (const row of table.rows) {
			for (const id of [field(row, table.columns, "pre_root_id"), field(row, table.columns, "post_root_id")]) {
				if (id !== "" && !cells.has(id)) unknownEndpoints.add(id);
			}
		}
	}

	// Canonical neuron order: numerically ascending root ids (BigInt-safe —
	// Codex root ids exceed 2^53), so builds are byte-deterministic.
	const neuronIds = [...cells.keys(), ...unknownEndpoints].sort(compareRootIds);
	const neuronCount = neuronIds.length;
	const indexOf = new Map<string, number>(neuronIds.map((id, index) => [id, index]));

	// Pass 3 — connections, aggregation sweep: (pre, post) → signed syn sum.
	// key = pre * neuronCount + post; neuronCount ≤ ~170k → key < 2^53. Safe.
	const edgeSums = new Map<number, number>();
	let unknownNtRows = 0;
	{
		const table = await openCsv(connectionsPath);
		for await (const row of table.rows) {
			const preId = field(row, table.columns, "pre_root_id");
			const postId = field(row, table.columns, "post_root_id");
			const pre = indexOf.get(preId);
			const post = indexOf.get(postId);
			if (pre === undefined || post === undefined) continue;
			const synCount = Number.parseInt(field(row, table.columns, "syn_count"), 10);
			if (!Number.isFinite(synCount)) continue;
			let nt = field(row, table.columns, "nt_type").toLowerCase();
			if (nt === "") nt = (cells.get(preId)?.nt ?? "").toLowerCase();
			const sign = NT_SIGN[nt];
			if (sign === undefined) {
				unknownNtRows++;
			}
			const key = pre * neuronCount + post;
			edgeSums.set(key, (edgeSums.get(key) ?? 0) + synCount * (sign ?? 1));
		}
	}

	const edgeKeys = [...edgeSums.keys()].sort((a, b) => a - b).filter((key) => edgeSums.get(key) !== 0);
	const edgeCount = edgeKeys.length;

	// Per-neuron arrays + type table.
	const typeSet = new Set<string>();
	for (const record of cells.values()) typeSet.add(record.type);
	const typeTable = [...typeSet].sort();
	const typeIndexOf = new Map(typeTable.map((name, index) => [name, index]));

	const group = new Uint8Array(neuronCount);
	const region = new Uint8Array(neuronCount);
	const typeIndex = new Uint16Array(neuronCount);
	const countsByGroup: Record<string, number> = {};
	for (const g of FLY_GROUPS) countsByGroup[g.name] = 0;
	neuronIds.forEach((id, index) => {
		const record = cells.get(id);
		const groupName = record?.group ?? "OTHER";
		const gid = GROUP_INDEX[groupName];
		group[index] = gid;
		region[index] = FLY_GROUPS[gid].region;
		typeIndex[index] = typeIndexOf.get(record?.type ?? "") ?? 0;
		countsByGroup[groupName]++;
	});

	const edgePre = new Uint32Array(edgeCount);
	const edgePost = new Uint32Array(edgeCount);
	const edgeWeight = new Float32Array(edgeCount);
	edgeKeys.forEach((key, index) => {
		edgePre[index] = Math.floor(key / neuronCount);
		edgePost[index] = key % neuronCount;
		edgeWeight[index] = edgeSums.get(key) ?? 0;
	});

	return {
		graph: { neuronCount, edgeCount, group, region, typeIndex, edgePre, edgePost, edgeWeight, typeTable, countsByGroup },
		report: { neurons: neuronCount, edges: edgeCount, unknownEndpoints: unknownEndpoints.size, unknownNtRows, typeCount: typeTable.length, countsByGroup },
	};
}

// ── Encoding ────────────────────────────────────────────────────────────────

export function encodeBinary(graph: Graph): Uint8Array {
	const headerBytes = 24; // magic(4) + version(2) + reserved(2) + 4 × u32
	const neuronBytes = 5; // u8 region + u16 group + u16 type
	const buffer = new ArrayBuffer(headerBytes + graph.edgeCount * 12 + graph.neuronCount * neuronBytes);
	const view = new DataView(buffer);
	let offset = 0;
	view.setUint32(offset, MAGIC, true);
	offset += 4;
	view.setUint16(offset, FORMAT_VERSION, true);
	offset += 2;
	view.setUint16(offset, 0, true);
	offset += 2;
	view.setUint32(offset, graph.neuronCount, true);
	offset += 4;
	view.setUint32(offset, graph.edgeCount, true);
	offset += 4;
	view.setUint32(offset, FLY_GROUPS.length, true);
	offset += 4;
	view.setUint32(offset, graph.typeTable.length, true);
	offset += 4;
	for (let i = 0; i < graph.edgeCount; i++) {
		view.setUint32(offset, graph.edgePre[i], true);
		view.setUint32(offset + 4, graph.edgePost[i], true);
		view.setFloat32(offset + 8, graph.edgeWeight[i], true);
		offset += 12;
	}
	for (let i = 0; i < graph.neuronCount; i++) {
		view.setUint8(offset, graph.region[i]);
		view.setUint16(offset + 1, graph.group[i], true);
		view.setUint16(offset + 3, graph.typeIndex[i], true);
		offset += neuronBytes;
	}
	return new Uint8Array(buffer);
}

export function buildManifest(graph: Graph, binaryGz: Uint8Array, options: BuildOptions): FlyBrainManifest {
	return {
		format: "fly-brain-manifest/1",
		generatedAt: options.stamp,
		generator: "scripts/build-fly-connectome.ts",
		source: options.source,
		binary: {
			file: "connectome.bin.gz",
			formatVersion: FORMAT_VERSION,
			sha256: createHash("sha256").update(binaryGz).digest("hex"),
			sizeBytes: binaryGz.byteLength,
			neuronCount: graph.neuronCount,
			edgeCount: graph.edgeCount,
		},
		weights: {
			unit: "signed-syn-count",
			aggregation: "sum of syn_count per neuron pair across neuropils",
			excitatory: EXCITATORY_NTS,
			inhibitory: INHIBITORY_NTS,
			unknownDefaultsTo: "+1 (rows counted in build report)",
		},
		groups: FLY_GROUPS.map((g, id) => ({ id, name: g.name, region: ["sensory", "central", "motor"][g.region] })),
		countsByGroup: graph.countsByGroup,
		types: graph.typeTable,
		circuit: {
			danClusterRule: "DAN cell_type prefix PPL1* → DAN_PPL1 (punitive), PAM* → DAN_PAM (reward), other → DAN_OTHER",
			giantFiberTypes: [...options.gfTypes],
		},
		notes: [
			"Group rules are tuned to FlyWire-family class values (snedea FAFB-verified vocabulary); re-check the printed group distribution against MCNS typing at the first real data run.",
			"The binary contains the FULL connectome; the worker instantiates only the learning-circuit subgraph (group/type filter).",
		],
	};
}

/** Full pipeline: CSVs → { gzipped binary, manifest, report }. */
export async function buildConnectome(
	cellTypesPath: string,
	connectionsPath: string,
	options: BuildOptions,
): Promise<{ binaryGz: Uint8Array; manifest: FlyBrainManifest; report: BuildReport }> {
	const { graph, report } = await buildGraph(cellTypesPath, connectionsPath, options);
	const binaryGz = gzipSync(encodeBinary(graph), { level: 9 });
	return { binaryGz, manifest: buildManifest(graph, binaryGz, options), report };
}

// ── Fixture ─────────────────────────────────────────────────────────────────
// Tiny synthetic connectome in the exact Codex CSV shape. Deterministic
// (seeded LCG); exercises every group rule, NT signs, cross-neuropil
// aggregation, unknown-endpoint append, and BigInt-order root ids.

export interface FixtureCsv {
	cellTypes: string;
	connections: string;
}

export function generateFixtureCsv(): FixtureCsv {
	let seed = 42;
	const rand = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	const id = (n: number) => String(1000000000n + BigInt(n) * 37n);
	// One 19-digit root id (FAFB/MCNS ids exceed 2^53) to pin BigInt ordering.
	const bigId = "720575940630000001";

	interface Spec {
		cls: string;
		cellType: string;
		count: number;
		nt: string;
	}
	const specs: Spec[] = [
		{ cls: "olfactory", cellType: "Or42b", count: 20, nt: "ACH" },
		{ cls: "alpn", cellType: "PN_cluster", count: 10, nt: "ACH" },
		{ cls: "alln", cellType: "LN_cluster", count: 6, nt: "GABA" },
		{ cls: "kenyon_cell", cellType: "KC_g", count: 60, nt: "ACH" },
		{
			cls: "mbon",
			cellType: "MBON",
			count: 8,
			nt: "ACH",
		},
		{ cls: "dan", cellType: "PPL1", count: 3, nt: "DA" },
		{ cls: "dan", cellType: "PAM", count: 2, nt: "DA" },
		{ cls: "dan", cellType: "PPL2", count: 1, nt: "DA" },
		{ cls: "descending_neuron", cellType: "giant fiber", count: 2, nt: "ACH" },
		{ cls: "cx", cellType: "EPG", count: 5, nt: "ACH" },
		{ cls: "lhln", cellType: "", count: 3, nt: "GABA" },
		{ cls: "unknown", cellType: "", count: 2, nt: "" },
	];

	const cellLines = ["root_id,super_class,class,sub_class,cell_type,resolved_type,nt_type,side,flow"];
	const neurons: { id: string; kind: string; index: number }[] = [];
	let next = 0;
	for (const spec of specs) {
		for (let i = 0; i < spec.count; i++) {
			const rootId = id(next);
			const cellType = spec.cellType === "MBON" || spec.cellType === "Or42b" ? `${spec.cellType}_${i + 1}` : spec.cellType;
			neurons.push({ id: rootId, kind: spec.cellType, index: next });
			cellLines.push(`${rootId},central,${spec.cls},${spec.cls},${cellType},${cellType},${spec.nt},${i % 2 === 0 ? "L" : "R"},${spec.cls === "olfactory" ? "afferent" : "intrinsic"}`);
			next++;
		}
	}
	// One 19-digit root id (FAFB/MCNS ids exceed 2^53), isolated on purpose:
	// it pins BigInt-safe ordering without perturbing the wired edge fixtures.
	cellLines.push(`${bigId},central,cx,cx,EPG_extra,EPG_extra,ACH,L,intrinsic`);

	const connLines = ["pre_root_id,post_root_id,syn_count,nt_type,neuropil"];
	const connect = (from: number, to: number, syn: number, nt: string, neuropil: string): void => {
		connLines.push(`${id(from)},${id(to)},${syn},${nt},${neuropil}`);
	};
	const osnFirst = 0;
	const pnFirst = 20;
	const lnFirst = 30;
	const kcFirst = 36;
	const mbonFirst = 96;
	const ppl1First = 104;
	const pamFirst = 107;
	const gfFirst = 110;
	const cxFirst = 112;
	for (let i = 0; i < 20; i++) {
		connect(osnFirst + i, pnFirst + (i % 10), 5 + Math.floor(rand() * 25), "ACH", "AL");
	}
	for (let i = 0; i < 6; i++) {
		connect(lnFirst + i, pnFirst + i, 8, "GABA", "AL");
	}
	for (let i = 0; i < 10; i++) {
		for (let k = 0; k < 6; k++) {
			connect(pnFirst + i, kcFirst + ((i * 6 + k) % 60), 1 + Math.floor(rand() * 4), "ACH", "MB_CA");
		}
	}
	for (let i = 0; i < 60; i++) {
		connect(kcFirst + i, mbonFirst + (i % 8), 2 + Math.floor(rand() * 6), "ACH", "MB_CA");
	}
	// DAN wiring; PPL1-1 synapses onto the same KC twice in different neuropils —
	// exercises cross-neuropil aggregation.
	connect(ppl1First, kcFirst + 1, 10, "DA", "MB_VL");
	connect(ppl1First, kcFirst + 1, 6, "DA", "MB_ML");
	connect(ppl1First + 1, mbonFirst, 12, "DA", "MB_VL");
	connect(ppl1First + 2, mbonFirst + 1, 7, "DA", "MB_VL");
	connect(pamFirst, kcFirst + 2, 14, "DA", "MB_VL");
	connect(pamFirst + 1, mbonFirst + 2, 9, "DA", "MB_ML");
	// GF flourish: giant fiber → a central-complex neuron and an unknown target.
	connect(gfFirst, cxFirst, 30, "ACH", "GNG");
	connect(gfFirst + 1, 40000, 5, "ACH", "T1_L"); // endpoint absent from cell table
	// Untyped/unknown-NT rows (sign fallback to pre-neuron NT, then +1).
	connect(cxFirst, mbonFirst + 3, 4, "", "CX");
	connect(40001, 40002, 3, "unknown_nt", "GNG");

	return { cellTypes: `${cellLines.join("\n")}\n`, connections: `${connLines.join("\n")}\n` };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const DEFAULT_SOURCE: ManifestSource = {
	dataset: "mcns",
	version: "1.0",
	access: "Codex static export (consolidated_cell_types + connections_princeton)",
	license: "CC-BY-4.0",
	attribution:
		"Male Adult Fly CNS (MCNS) v1.0 — Janelia Research Campus (HHMI), University of Cambridge, MRC Laboratory of Molecular Biology, and Google; accessed via Codex (Princeton Neuroscience Institute). Licensed CC-BY 4.0.",
};

function parseArgs(argv: readonly string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const value = argv[i + 1]?.startsWith("--") === false ? argv[++i] : "true";
		args.set(arg.slice(2), value);
	}
	return args;
}

/** Accepts both the Codex API naming and the Codex UI export naming. */
function resolveInput(dir: string, candidates: readonly string[]): string {
	for (const candidate of candidates) {
		for (const suffix of [".csv.gz", ".csv"] as const) {
			const path = join(dir, `${candidate}${suffix}`);
			if (existsSync(path)) return path;
		}
	}
	throw new Error(`None of ${candidates.map((candidate) => `${candidate}.csv(.gz)`).join(", ")} found in ${dir}`);
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	const repoRoot = resolve(import.meta.dir, "..");
	const fixtureOut = args.get("fixture");
	if (fixtureOut === "true") {
		console.error("--fixture requires an output directory argument");
		process.exit(1);
	}
	const outDir = resolve(repoRoot, args.get("out") ?? fixtureOut ?? join("services", "api", "assets", "fly"));
	const gfTypes = (args.get("gf-types") ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
	const isFixture = fixtureOut !== undefined;
	const stamp = args.get("stamp") ?? (isFixture ? "1970-01-01T00:00:00.000Z" : new Date().toISOString());
	const options: BuildOptions = {
		gfTypes,
		stamp,
		source: {
			...DEFAULT_SOURCE,
			dataset: args.get("dataset") ?? DEFAULT_SOURCE.dataset,
			version: args.get("dataset-version") ?? DEFAULT_SOURCE.version,
		},
	};

	let dataDir: string;
	if (isFixture) {
		dataDir = join(outDir, "_fixture-src");
		await mkdir(dataDir, { recursive: true });
		const fixture = generateFixtureCsv();
		await writeFile(join(dataDir, "cell_types.csv"), fixture.cellTypes);
		await writeFile(join(dataDir, "connections.csv"), fixture.connections);
	} else {
		dataDir = resolve(repoRoot, args.get("data-dir") ?? "");
		if (args.get("data-dir") === undefined) {
			console.error("Usage: bun scripts/build-fly-connectome.ts --data-dir <dir> | --fixture <out-dir> [--out dir] [--gf-types a,b]");
			process.exit(1);
		}
	}

	const { binaryGz, manifest, report } = await buildConnectome(
		resolveInput(dataDir, ["cell_types", "neurons"]),
		resolveInput(dataDir, ["connections", "connections_princeton"]),
		options,
	);

	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, "connectome.bin.gz"), binaryGz);
	await writeFile(join(outDir, "fly-brain-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	console.log(` neurons: ${report.neurons} (unknown-endpoint additions: ${report.unknownEndpoints})`);
	console.log(` edges:   ${report.edges} (rows with unknown NT: ${report.unknownNtRows})`);
	console.log(` types:   ${report.typeCount}`);
	for (const [name, count] of Object.entries(report.countsByGroup)) console.log(`   ${name.padEnd(10)} ${count}`);
	const expectedNeurons = args.get("expected-neurons");
	const expectedConnections = args.get("expected-connections");
	if (expectedNeurons !== undefined && Number.parseInt(expectedNeurons, 10) !== report.neurons) {
		console.warn(` WARN: expected ${expectedNeurons} neurons, got ${report.neurons}`);
	}
	if (expectedConnections !== undefined) {
		console.warn(` NOTE: dataset lists ${expectedConnections} source connections (pre-aggregation); binary holds ${report.edges} aggregated edges.`);
	}
	console.log(` wrote:   ${join(outDir, "connectome.bin.gz")} (${(binaryGz.byteLength / 1024 / 1024).toFixed(2)} MB, sha256 ${manifest.binary.sha256.slice(0, 12)}…)`);
	console.log(`          ${join(outDir, "fly-brain-manifest.json")}`);
}

if (import.meta.main) {
	await main();
}
