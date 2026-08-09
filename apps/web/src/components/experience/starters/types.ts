/**
 * Visual starter type + fixture phases (IR-63). Shared by the five starter
 * modules and the starter registry so no starter depends on another.
 */

/** The five representative phases the editor preview can render. */
export type FixturePhase = "setup" | "ordinary" | "pending" | "error" | "completed";

/**
 * A projected view the preview pushes into the frame. Mirrors the
 * api-contracts projected-view shape (state/actions/revision/status/flavor) but
 * is deliberately untyped here so each starter can ship representative content
 * for its own state shape without importing the contract into the starter
 * module (starters stay import-free apart from this type).
 */
export interface PreviewFixture {
  readonly state: unknown;
  readonly actions: ReadonlyArray<{
    readonly type: string;
    readonly label?: string;
    readonly payload?: unknown;
  }>;
  readonly revision: number;
  readonly status: "active" | "completed" | "interrupted";
  readonly flavor?: unknown;
}

/** One fixture per phase, so the preview can switch the frame between them. */
export type FixtureSet = Readonly<Record<FixturePhase, PreviewFixture>>;

export interface VisualStarter {
  /** Stable id used as the copy source key in the editor (IR-81). */
  readonly id: string;
  /** Human-readable name shown in the "new visual from starter" picker. */
  readonly label: string;
  /** One-line description of what the starter is suited for. */
  readonly description: string;
  /** The editable HTML/CSS/JS source (self-contained; uses VibeExperience SDK). */
  readonly source: string;
  /** Representative projected fixtures for each preview phase. */
  readonly fixtures: FixtureSet;
}
