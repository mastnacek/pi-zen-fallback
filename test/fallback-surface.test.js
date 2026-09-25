/**
 * Characterization tests for the zen-fallback extension surface.
 *
 * Written before splitting the 1049-line module (line-limit campaign). The plugin had a
 * single test that asserted a locally-declared array without importing the plugin at all
 * — i.e. no real coverage — so these pin the extension's registration surface and smoke
 * the handlers, which is precisely what a refactor of this file could break.
 *
 * Only the default export is public, so everything is driven through it with a fake `pi`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../extensions/zen-fallback/index.ts";

/** Minimal ExtensionAPI double that records what the extension registers. */
function fakePi() {
	const events = [];
	const commands = [];
	const pi = {
		on(event, handler) {
			events.push({ event, handler });
			return () => {};
		},
		registerCommand(name, def) {
			commands.push({ name, def });
		},
		registerTool() {},
		registerProvider() {},
		appendEntry() {},
		setModel: async () => true,
		events: { emit() {}, on() {} },
	};
	return { pi, events, commands };
}

/** Headless context: every UI path returns early, so the handlers are safe to call. */
function fakeCtx(over = {}) {
	return {
		hasUI: false,
		cwd: process.cwd(),
		model: undefined,
		thinkingLevel: undefined,
		signal: undefined,
		ui: { notify() {}, setStatus() {}, setWidget() {}, theme: { fg: (_c, t) => t } },
		modelRegistry: { getProvider: () => undefined, find: () => undefined },
		sessionManager: { getEntries: () => [] },
		...over,
	};
}

const handlerFor = (events, name) => events.find((e) => e.event === name)?.handler;

test("registers every expected event handler", () => {
	const { pi, events } = fakePi();
	plugin(pi);
	assert.deepEqual(
		events.map((e) => e.event).sort(),
		["after_provider_response", "before_provider_request", "model_select", "session_shutdown", "session_start"],
	);
	// Registration must produce callable handlers, and each must have kept its arity.
	for (const { event, handler } of events) {
		assert.equal(typeof handler, "function", `${event} handler is a function`);
	}
});

test("registers every expected slash command", () => {
	const { pi, commands } = fakePi();
	plugin(pi);
	assert.deepEqual(
		commands.map((c) => c.name).sort(),
		["zen", "zen-refresh", "zen-reset", "zen-status", "zen-toggle", "zen-widget"],
	);
	for (const { name, def } of commands) {
		assert.ok(def && typeof def === "object", `${name} has a definition object`);
	}
});

test("session_start and model_select run headless without throwing", async () => {
	const { pi, events } = fakePi();
	plugin(pi);
	const ctx = fakeCtx();
	await handlerFor(events, "session_start")({}, ctx);
	await handlerFor(events, "model_select")({}, ctx);
});

test("before_provider_request and after_provider_response run headless without throwing", async () => {
	const { pi, events } = fakePi();
	plugin(pi);
	const ctx = fakeCtx();
	await handlerFor(events, "before_provider_request")({ model: undefined }, ctx);
	await handlerFor(events, "after_provider_response")({ status: 200, model: undefined }, ctx);
});

test("a non-zen model is ignored: no fallback attempt", async () => {
	const { pi, events } = fakePi();
	let setModelCalls = 0;
	pi.setModel = async () => {
		setModelCalls += 1;
		return true;
	};
	plugin(pi);
	const ctx = fakeCtx({ model: { provider: "anthropic", id: "claude-something" } });
	await handlerFor(events, "after_provider_response")({ status: 429, model: ctx.model }, ctx);
	assert.equal(setModelCalls, 0, "only zen-provider models trigger the fallback");
});

test("session_shutdown unsubscribes cleanly", async () => {
	const { pi, events } = fakePi();
	plugin(pi);
	await handlerFor(events, "session_shutdown")({}, fakeCtx());
});

test("the /zen command exposes a runnable handler", () => {
	const { pi, commands } = fakePi();
	plugin(pi);
	const zen = commands.find((c) => c.name === "zen");
	assert.equal(typeof zen?.def?.handler, "function", "commands are registered with a handler");
});
