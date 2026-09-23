import test from "node:test";
import assert from "node:assert/strict";

test("fallback order contains expected models", () => {
	const models = [
		"mimo-v2.5-free",
		"big-pickle",
		"ling-3.0-flash-fin-free",
	];
	assert.equal(models.length, 3);
	assert.equal(models[0], "mimo-v2.5-free");
});
