/**
 * pi-zen-fallback — switches to a zen free model when the active one fails.
 *
 * The catalogue, cache and status helpers live in sibling modules, as do the slash
 * command definitions; this module keeps the fallback decision and the event wiring.
 */
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { AUTH_STATUSES, TRIGGER_STATUSES, FAIL_COOLDOWN_MS, SWITCH_COOLDOWN_MS, zenCatalog } from "./zen-data.ts";
import { ensureZenProviderRegistered, ZEN_KEY_DOCS } from "./zen-cache.ts";
import { state, isZenProvider, refreshStatus, refreshWidget, zenStatus } from "./zen-status.ts";
import { registerZenCommand } from "./zen-command.ts";
import { registerZenCommands } from "./zen-commands.ts";

let statusTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 401/403 are not rate limits. The Zen free tier refuses every client that is not
 * opencode itself (identical headers still get 403), so no other free model will
 * pass either — switching is pointless. Explain the API-key requirement instead,
 * at most once a minute.
 */
function notifyAuthRejection(ctx: ExtensionContext, status: number): void {
	const now = Date.now();
	if (now - state.authNoticeAt < 2 * SWITCH_COOLDOWN_MS) return;
	state.authNoticeAt = now;
	if (status === 401) {
		zenStatus.keyConfigured = false;
		ctx.ui.notify(
			"Zen: neplatný API klíč (401) — zkontroluj ZEN_API_KEY / OPENCODE_API_KEY.",
			"error",
		);
	} else {
		ctx.ui.notify(
			`Zen: free tier odmítnut (403) — bez klíče běží modely jen z opencode. ` +
				`Vytvoř klíč na ${ZEN_KEY_DOCS} a nastav ZEN_API_KEY.`,
			"error",
		);
	}
	refreshStatus(ctx);
	refreshWidget(ctx);
}

async function maybeFallback(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	const model = ctx.model;
	if (!model) return;
	if (!isZenProvider(ctx)) return;

	const now = Date.now();
	if (now - state.lastSwitchAt < SWITCH_COOLDOWN_MS) return;

	// Walk the fallback list forward from the current model, skipping any model
	// that is currently marked as exhausted.
	const start = zenCatalog.order.indexOf(model.id);
	const candidates: string[] = [];
	for (let i = 1; i <= zenCatalog.order.length; i++) {
		candidates.push(zenCatalog.order[(start + i) % zenCatalog.order.length]);
	}

	let chosenId: string | null = null;
	for (const id of candidates) {
		if ((state.failedUntil.get(id) ?? 0) > now) continue; // still cooling down
		if (ctx.modelRegistry.find(model.provider, id)) {
			chosenId = id;
			break;
		}
	}

	if (!chosenId) {
		state.lastSwitchAt = now;
		ctx.ui.notify(
			"Zen: all free models are currently rate-limited, cooling down.",
			"warning",
		);
		refreshStatus(ctx);
		refreshWidget(ctx);
		return;
	}

	const target = ctx.modelRegistry.find(model.provider, chosenId);
	if (!target) return;

	const ok = await pi.setModel(target);
	if (!ok) {
		ctx.ui.notify(
			`Zen: could not switch to ${chosenId} (no credentials).`,
			"error",
		);
		return;
	}

	state.lastSwitchAt = now;
	// Mark the exhausted model so we don't immediately flip back to it.
	state.failedUntil.set(model.id, now + FAIL_COOLDOWN_MS);
	ctx.ui.notify(
		`Zen: ${model.id} rate-limited → switched to ${chosenId}`,
		"info",
	);
	pi.events.emit("zen:fallback", { from: model.id, to: chosenId });
	refreshStatus(ctx);
	refreshWidget(ctx);
}

export default function (pi: ExtensionAPI) {
	/** Unsubscribers from every `pi.on()`; drained on session_shutdown (AGENTS §5). */
	const unsubscribers: Array<() => void> = [];

	/** Retain a `pi.on()` return value; older engine typings declare it void. */
	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	// Self-setup: make the zen free models available without editing
	// models.json (no-op when the user already configured zenfree there).
	ensureZenProviderRegistered(pi);

	// Initial paint + live timer for status/widget (started with the session,
	// torn down with it — never from the factory).
	track(pi.on("session_start", (_event, ctx) => {
		refreshStatus(ctx);
		refreshWidget(ctx);
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = setInterval(() => {
			refreshStatus(ctx);
			refreshWidget(ctx);
		}, 30_000);
	}));

	pi.on("session_shutdown", () => {
		while (unsubscribers.length > 0) unsubscribers.pop()?.();
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
	});

	// Keep the status line in sync when the user manually switches models.
	track(pi.on("model_select", (event, ctx) => {
		refreshStatus(ctx, event.model);
		refreshWidget(ctx, event.model);
	}));

	// Capture which model the outgoing request actually targets. This lets us
	// correlate the failing response with the active model, so we don't wrongly
	// fall back when a *small-model* call (session title, summarizer, ...) that
	// uses a different model happens to get rate-limited.
	track(pi.on("before_provider_request", (event) => {
		const requested = (event as { payload?: { model?: unknown } }).payload?.model;
		if (typeof requested === "string") state.lastRequestModelId = requested;
	}));

	track(pi.on("after_provider_response", async (event, ctx) => {
		if (!state.enabled) return;
		const model = ctx.model;
		if (!model) return;
		// STRICT gate: only ever act for the zen free provider.
		if (!isZenProvider(ctx)) return;
		// Correlation: only react when the failed request was for the active
		// model (skip small-model / title / summarizer calls on other models).
		if (state.lastRequestModelId && state.lastRequestModelId !== model.id) return;
		if (AUTH_STATUSES.has(event.status)) {
			notifyAuthRejection(ctx, event.status);
			return;
		}
		if (!TRIGGER_STATUSES.has(event.status)) return;
		await maybeFallback(pi, ctx);
	}));

	/* -------- commands -------- */

	registerZenCommand(pi);
	registerZenCommands(pi);
}
