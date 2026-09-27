/// <reference lib="webworker" />

/**
 * Fly Tribunal Web Worker (FLY_TRIBUNAL_PLAN FT-7).
 *
 * This is deliberately a thin protocol shell. `fly-engine-core.ts` owns every
 * parser, encoder, LIF, readout, and plasticity operation; this entrypoint only
 * provides browser gzip decompression and serializes calls for the app-lifetime
 * worker from `fly-client-instance.ts`.
 */

import type { FlyBrainManifest } from "@vibe-tavern/api-contracts";
import {
  createFlyEngine,
  parseConnectome,
  type FlyDanCluster,
  type FlyEngine,
  type FlyEngineParams,
  type FlyEvaluation,
} from "./fly-engine-core.js";

export type FlyWorkerRequest =
  | { type: "load"; id?: number; bytes: ArrayBuffer; manifest: Pick<FlyBrainManifest, "types"> }
  | { type: "evaluate"; id: number; text: string }
  | { type: "train"; id?: number; text: string; danCluster: FlyDanCluster; strength: number }
  | { type: "reset-weights"; id?: number }
  | { type: "set-params"; id?: number; params: Partial<FlyEngineParams> }
  | { type: "dispose" };

export type FlyWorkerResponse =
  | { type: "loaded"; id?: number; neuronCount: number; edgeCount: number }
  | { type: "evaluated"; id: number; result: FlyEvaluation }
  | { type: "trained"; id?: number; result: FlyEvaluation }
  | { type: "weights-reset"; id?: number }
  | { type: "params-set"; id?: number; params: FlyEngineParams }
  | { type: "error"; id?: number; name: string; message: string };

let engine: FlyEngine | null = null;

function post(response: FlyWorkerResponse): void {
  self.postMessage(response);
}

function postError(id: number | undefined, error: unknown): void {
  post({
    type: "error",
    id,
    name: error instanceof Error ? error.name : "FlyWorkerError",
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Browser-only gzip seam supplied to the pure core parser. */
async function decompressGzip(compressed: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function requireEngine(): FlyEngine {
  if (engine === null) throw new Error("Fly Tribunal brain is not loaded — send a load request first.");
  return engine;
}

self.onmessage = async (event: MessageEvent<FlyWorkerRequest>): Promise<void> => {
  const message = event.data;
  try {
    switch (message.type) {
      case "load": {
        const connectome = await parseConnectome(new Uint8Array(message.bytes), decompressGzip);
        engine = createFlyEngine(connectome, { typeNames: message.manifest.types });
        post({
          type: "loaded",
          id: message.id,
          neuronCount: engine.subgraph.neuronCount,
          edgeCount: engine.subgraph.edgeCount,
        });
        return;
      }
      case "evaluate": {
        post({ type: "evaluated", id: message.id, result: requireEngine().evaluate(message.text) });
        return;
      }
      case "train": {
        const loaded = requireEngine();
        loaded.trainText(message.text, message.danCluster, message.strength);
        post({ type: "trained", id: message.id, result: loaded.evaluate(message.text) });
        return;
      }
      case "reset-weights": {
        requireEngine().resetWeights();
        post({ type: "weights-reset", id: message.id });
        return;
      }
      case "set-params": {
        post({ type: "params-set", id: message.id, params: requireEngine().setParams(message.params) });
        return;
      }
      case "dispose": {
        engine = null;
        return;
      }
    }
  } catch (error) {
    postError("id" in message ? message.id : undefined, error);
  }
};
