/**
 * RO-6 review-outcome contract fixtures (REVIEW_OUTCOME_FEEDBACK_PLAN).
 *
 * Each fixture is the exact list of HTTP request bodies a mounted review flow
 * sends. The web suites pin "real user action → exactly these bodies"; the
 * server suite (`services/api/test/review-outcome-integration.test.ts`)
 * replays the SAME files through the real routes into provider-bound prompts
 * and tool bases. Together they prove action → request → provider without a
 * cross-workspace process bridge.
 *
 * The files live beside the shared wire contract in
 * `packages/api-contracts/test/fixtures/review-outcome/` so both workspaces
 * read one source. A changed client body fails here first; update the fixture
 * deliberately and the server replay re-proves it.
 */
import { expect } from "bun:test";
import { resolve } from "node:path";

export type ReviewOutcomeSurface = "coauthor" | "copilot";

export interface ReviewOutcomeFixtureRequest {
	/** Which client transport sent the body: co-author non-stream/stream, or the copilot stream. */
	mode: "nonstream" | "stream";
	body: unknown;
}

export interface ReviewOutcomeFixture {
	surface: ReviewOutcomeSurface;
	scenario: string;
	requests: ReviewOutcomeFixtureRequest[];
}

const FIXTURE_DIR = resolve(import.meta.dir, "../../../packages/api-contracts/test/fixtures/review-outcome");

export async function readReviewOutcomeFixture(name: string): Promise<ReviewOutcomeFixture> {
	return (await Bun.file(resolve(FIXTURE_DIR, `${name}.json`)).json()) as ReviewOutcomeFixture;
}

/** Pins the bodies a mounted flow actually sent against the shared fixture. */
export async function expectReviewOutcomeFixture(name: string, actual: ReviewOutcomeFixture): Promise<void> {
	expect(actual).toEqual(await readReviewOutcomeFixture(name));
}
