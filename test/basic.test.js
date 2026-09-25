import test from "node:test";
import assert from "node:assert/strict";
import {
	AUTH_STATUSES,
	DEPRECATED_FREE_IDS,
	FREE_MODELS,
	NON_CHAT_FREE_IDS,
	TRIGGER_STATUSES,
	zenCatalog,
} from "../extensions/zen-fallback/zen-data.ts";
import { resolveZenApiKey } from "../extensions/zen-fallback/zen-cache.ts";

test("fallback order starts on the current default and holds only live models", () => {
	assert.equal(zenCatalog.order[0], "mimo-v2.6-flash-free");
	for (const id of zenCatalog.order) {
		assert.ok(!DEPRECATED_FREE_IDS.has(id), `${id} must not be deprecated`);
		assert.ok(!NON_CHAT_FREE_IDS.has(id), `${id} must be a chat model`);
		assert.ok(
			FREE_MODELS.some((m) => m.id === id),
			`${id} must be described in FREE_MODELS`,
		);
	}
});

test("the anonymous fallback key is only used when no env key is set", () => {
	const savedZen = process.env.ZEN_API_KEY;
	const savedOpenCode = process.env.OPENCODE_API_KEY;
	try {
		delete process.env.ZEN_API_KEY;
		delete process.env.OPENCODE_API_KEY;
		assert.equal(resolveZenApiKey().apiKey, "public");

		process.env.ZEN_API_KEY = "zk_test";
		assert.equal(resolveZenApiKey().apiKey, "zk_test");

		delete process.env.ZEN_API_KEY;
		process.env.OPENCODE_API_KEY = "oc_test";
		assert.equal(resolveZenApiKey().apiKey, "oc_test");
	} finally {
		if (savedZen === undefined) delete process.env.ZEN_API_KEY;
		else process.env.ZEN_API_KEY = savedZen;
		if (savedOpenCode === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = savedOpenCode;
	}
});

test("401/403 are auth rejections, never fallback triggers", () => {
	assert.ok(AUTH_STATUSES.has(401));
	assert.ok(AUTH_STATUSES.has(403));
	for (const status of AUTH_STATUSES) {
		assert.ok(!TRIGGER_STATUSES.has(status), `${status} must not trigger a switch`);
	}
});
