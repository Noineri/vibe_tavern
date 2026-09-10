/**
 * Gallery serve-URL boundary pin. `serveCharacterAssetUrl` feeds every
 * `<img src>` in the gallery surfaces (grid, viewer, lightbox, media
 * menu/modal, avatar-crop source) — and `<img>` cannot send an Authorization
 * header. The serve route is behind the mobile/LAN auth gate (unlike legacy
 * flat `/api/assets/*` reads, which the server keeps public), so the URL MUST
 * carry the stored mobile token as `?token=` or every gallery image 401s on
 * mobile while desktop (loopback) keeps working. Mirrors the avatar fix
 * (`resolveEntityAvatarUrl`), same `appendTokenQuery` helper.
 */

import { afterEach, describe, expect, test } from "bun:test";

const { useDomEnv } = await import("../../test/dom-env.js");
useDomEnv();

const { getGatewayBaseUrl } = await import("../gateway-client.js");
const { clearMobileToken, saveMobileToken } = await import("../lib/mobile-token.js");
const { serveCharacterAssetUrl } = await import("./gallery-api.js");

const characterId = "chr_test";
const rowId = "gal_row_1";
const bareUrl = () => `${getGatewayBaseUrl()}/api/characters/${characterId}/assets/${rowId}`;

afterEach(() => {
	clearMobileToken();
});

describe("serveCharacterAssetUrl — mobile token on <img> URLs", () => {
	test("no stored token → clean URL (desktop shape unchanged)", () => {
		clearMobileToken();
		expect(serveCharacterAssetUrl(characterId, rowId)).toBe(bareUrl());
	});

	test("stored token → appended as encoded ?token= query", () => {
		saveMobileToken("tok en+1"); // space and plus must survive the query
		expect(serveCharacterAssetUrl(characterId, rowId)).toBe(
			`${bareUrl()}?token=${encodeURIComponent("tok en+1")}`,
		);
	});

	test("token cleared afterwards → URL is clean again", () => {
		saveMobileToken("secret");
		clearMobileToken();
		expect(serveCharacterAssetUrl(characterId, rowId)).toBe(bareUrl());
	});
});
