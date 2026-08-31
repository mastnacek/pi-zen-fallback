/**
 * zen-fallback.ts
 * ----------------
 * Auto-fallback solver for the free-tier OpenCode Zen provider (`zenfree`).
 *
 * Why: the free Zen models get rate-limited independently (HTTP 429 /
 * `FreeUsageLimitError`). There is no quota endpoint, so the only reliable
 * signal is the HTTP status code of each provider request. When the model
 * pi is currently using hits its limit, this extension switches to the next
 * model that is not currently exhausted.
 *
 * It is scoped STRICTLY to the configured zen provider: if you switch to any
 * other provider (paid models, etc.) nothing happens — the provider-id check
 * below must match before any fallback logic runs.
 *
 * Commands:
 *   /zen-status   show current fallback state
 *   /zen-reset    clear exhausted-model marks and return to the default model
 *   /zen-toggle   enable/disable auto-fallback for this process
 *   /zen-widget   toggle a detailed widget above the editor
 *
 * Status line: shows `zen:ON/OFF · <model> · ⏳<cooldown>` in the footer via
 * ctx.ui.setStatus("zen-fallback", ...). Refreshed on events and by a small
 * timer while the session is running.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

// Provider id of the zen free tier as registered in models.json / settings.json.
// If a paid/real OpenCode Zen is added later under a different provider id
// (e.g. "opencode"), it will NOT be touched by this extension.
const ZEN_PROVIDER = "zenfree";

// Extra safety: only act when the provider's base URL actually points at the
// zen gateway. Guards against a provider id collision.
const ZEN_BASE_URL_MARKER = "opencode.ai/zen";

// Fallback priority. index 0 is the preferred/default model. We walk this list
// forward (skipping the ones currently rate-limited) on each failure.
const FALLBACK_ORDER = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"nemotron-3.5-lightning-free",
	"laguna-s-2.1-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"big-pickle",
];

// HTTP statuses that we treat as "model temporarily unavailable, switch away".
// 429 is the zen free-tier `FreeUsageLimitError`. 502/503 = transient overload.
const TRIGGER_STATUSES = new Set([429, 502, 503]);

// A model marked "failed" is skipped until this much time passes, so it can
// recover and be reused later instead of being burned forever.
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;

// Minimum gap between automatic switches, to avoid thrashing when several
// models fail in quick succession.
const SWITCH_COOLDOWN_MS = 30 * 1000;

/* ------------------------------------------------------------------ */
/* Self-setup: register the zenfree provider on a clean pi            */
/* ------------------------------------------------------------------ */

// Free-tier model catalogue. Used to register the zenfree provider from the
// extension, so installing this plugin on a fresh pi needs NO models.json
// editing. If the user already defined zenfree (with models) in models.json,
// their configuration is left completely untouched.
const FREE_MODELS = [
	{ id: "big-pickle", name: "Big Pickle (free)", reasoning: true },
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash Free",
		reasoning: true,
	},
	{ id: "hy3-free", name: "Hy3 Free", reasoning: true },
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true,
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true,
	},
	{ id: "mimo-v2.5-free", name: "MiMo V2.5 Free", reasoning: true },
	{ id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free", reasoning: true },
].map((m) => ({
	...m,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
}));

const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const ZEN_DEFAULT_UA =
	"opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

// Read the user's zenfree provider config from models.json (if any). Returns
// null when zenfree is not defined there at all. `hasModels` tells us whether
// the user supplies their own model list (so we must not clobber it).
function readZenfreeConfigFromModelsJson() {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const file = join(dir, "models.json");
	if (!existsSync(file)) return null;
	try {
		const cfg = JSON.parse(readFileSync(file, "utf8"));
		const p = cfg?.providers?.["zenfree"];
		if (!p || typeof p !== "object") return null;
		return {
			baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
			api: typeof p.api === "string" ? p.api : undefined,
			apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined,
			headers: p.headers && typeof p.headers === "object" ? p.headers : undefined,
			hasModels: Array.isArray(p.models) && p.models.length > 0,
		};
	} catch {
		return null;
	}
}

// Register the zenfree provider + free models unless the user already
// configured zenfree with models in models.json (in which case we defer to
// them entirely). Safe to call from the extension factory: pi applies
// registerProvider calls made during factory init before startup continues.
function ensureZenProviderRegistered(pi: ExtensionAPI): void {
	const existing = readZenfreeConfigFromModelsJson();
	if (existing?.hasModels) return; // user config wins — never clobber it

	pi.registerProvider("zenfree", {
		name: "OpenCode Zen (free)",
		baseUrl: existing?.baseUrl ?? ZEN_DEFAULT_BASE_URL,
		api: existing?.api ?? "openai-completions",
		apiKey: existing?.apiKey ?? "public",
		headers: existing?.headers ?? { "user-agent": ZEN_DEFAULT_UA },
		models: FREE_MODELS,
	});
}

/* ------------------------------------------------------------------ */
/* Runtime state (per process; reset on /reload)                       */
/* ------------------------------------------------------------------ */

interface ZenState {
	enabled: boolean;
	failedUntil: Map<string, number>; // modelId -> timestamp after which it may be tried again
	lastSwitchAt: number;
	lastRequestModelId: string | null; // model id of the most recent provider request
}

const state: ZenState = {
	enabled: true,
	failedUntil: new Map(),
	lastSwitchAt: 0,
	lastRequestModelId: null,
};

/* ------------------------------------------------------------------ */
/* Status line + widget helpers                                        */
/* ------------------------------------------------------------------ */

const STATUS_KEY = "zen-fallback";
const WIDGET_KEY = "zen-fallback-detail";
let statusTimer: ReturnType<typeof setInterval> | null = null;
let widgetVisible = false;

function isOnFallbackModel(modelId: string | undefined): boolean {
	return (
		!!modelId && modelId !== FALLBACK_ORDER[0] && FALLBACK_ORDER.includes(modelId)
	);
}

function isZenProvider(
	ctx: ExtensionContext,
	targetModel?: { provider?: string; id?: string },
): boolean {
	const model = targetModel ?? ctx.model;
	if (!model) return false;
	if (model.provider !== ZEN_PROVIDER) return false;
	// Secondary confirmation via base URL (best-effort).
	try {
		const p = ctx.modelRegistry.getProvider(model.provider);
		if (p?.baseUrl && !p.baseUrl.includes(ZEN_BASE_URL_MARKER)) return false;
	} catch {
		// If we can't inspect the provider, fall back to the id check only.
	}
	return true;
}

function formatStatus(
	ctx: ExtensionContext,
	targetModel?: { provider?: string; id?: string },
): string {
	const now = Date.now();
	const cooling = [...state.failedUntil].filter(
		([, until]) => until > now,
	).length;
	const current = targetModel?.id ?? ctx.model?.id;
	const theme = ctx.ui.theme;
	const parts: string[] = [];

	parts.push(
		state.enabled ? theme.fg("success", "zen:ON") : theme.fg("muted", "zen:OFF"),
	);

	if (current) {
		parts.push(theme.fg("text", current));
		if (isOnFallbackModel(current)) parts.push(theme.fg("warning", "(fb)"));
	}
	if (cooling > 0) parts.push(theme.fg("warning", `⏳${cooling}`));

	return parts.join(" ");
}

function refreshStatus(
	ctx: ExtensionContext,
	targetModel?: { provider?: string; id?: string },
): void {
	if (!ctx.hasUI) return;
	try {
		if (!isZenProvider(ctx, targetModel)) {
			ctx.ui.setStatus(STATUS_KEY, "");
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, formatStatus(ctx, targetModel));
	} catch {
		/* ignore */
	}
}

function refreshWidget(
	ctx: ExtensionContext,
	targetModel?: { provider?: string; id?: string },
): void {
	if (!widgetVisible) return;
	if (!ctx.hasUI) return;
	if (!isZenProvider(ctx, targetModel)) {
		try {
			ctx.ui.setWidget(WIDGET_KEY, []);
		} catch {
			/* ignore */
		}
		return;
	}
	const now = Date.now();
	const cooling = [...state.failedUntil]
		.filter(([, until]) => until > now)
		.sort((a, b) => a[1] - b[1]);
	const theme = ctx.ui.theme;
	const lines: string[] = [
		theme.fg("accent", "— zen fallback —") +
			` ${state.enabled ? theme.fg("success", "ON") : theme.fg("muted", "OFF")}`,
	];
	const current = targetModel ?? ctx.model;
	if (current) {
		const mark = isOnFallbackModel(current.id)
			? theme.fg("warning", " (fallback)")
			: "";
		lines.push(`${theme.fg("dim", "model:")} ${current.id}${mark}`);
	}
	if (cooling.length === 0) {
		lines.push(theme.fg("dim", "no models cooling down"));
	} else {
		lines.push(theme.fg("dim", "cooling down:"));
		for (const [id, until] of cooling) {
			const secs = Math.max(1, Math.round((until - now) / 1000));
			lines.push(
				`  ${theme.fg("warning", id)} ${theme.fg("dim", `(${Math.floor(secs / 60)}m ${secs % 60}s)`)}`,
			);
		}
	}
	try {
		ctx.ui.setWidget(WIDGET_KEY, lines);
	} catch {
		/* ignore */
	}
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
	const start = FALLBACK_ORDER.indexOf(model.id);
	const candidates: string[] = [];
	for (let i = 1; i <= FALLBACK_ORDER.length; i++) {
		candidates.push(FALLBACK_ORDER[(start + i) % FALLBACK_ORDER.length]);
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
			"warn",
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

/* ------------------------------------------------------------------ */
/* Event handlers                                                      */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI) {
	// Self-setup: make the zen free models available without editing
	// models.json (no-op when the user already configured zenfree there).
	ensureZenProviderRegistered(pi);

	// Initial paint + live timer for status/widget (started with the session,
	// torn down with it — never from the factory).
	pi.on("session_start", (_event, ctx) => {
		refreshStatus(ctx);
		refreshWidget(ctx);
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = setInterval(() => {
			refreshStatus(ctx);
			refreshWidget(ctx);
		}, 30_000);
	});

	pi.on("session_shutdown", () => {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = null;
		}
	});

	// Keep the status line in sync when the user manually switches models.
	pi.on("model_select", (event, ctx) => {
		refreshStatus(ctx, event.model);
		refreshWidget(ctx, event.model);
	});

	// Capture which model the outgoing request actually targets. This lets us
	// correlate the failing response with the active model, so we don't wrongly
	// fall back when a *small-model* call (session title, summarizer, ...) that
	// uses a different model happens to get rate-limited.
	pi.on("before_provider_request", (event) => {
		const requested = (event as { payload?: { model?: unknown } }).payload?.model;
		if (typeof requested === "string") state.lastRequestModelId = requested;
	});

	pi.on("after_provider_response", async (event, ctx) => {
		if (!state.enabled) return;
		if (!TRIGGER_STATUSES.has(event.status)) return;
		const model = ctx.model;
		if (!model) return;
		// STRICT gate: only ever act for the zen free provider.
		if (!isZenProvider(ctx)) return;
		// Correlation: only react when the failed request was for the active
		// model (skip small-model / title / summarizer calls on other models).
		if (state.lastRequestModelId && state.lastRequestModelId !== model.id) return;
		await maybeFallback(pi, ctx);
	});

	/* -------- commands -------- */

	const ZEN_DOCS: Record<string, string> = {
		status: "zobrazí aktuální stav fallbacku a chladnoucí modely",
		on: "zapne automatický fallback mezi Zen free modely",
		off: "vypne automatický fallback",
		toggle: "přepne stav zapnuto/vypnuto",
		reset: "vymaže cooldowny selhání a vrátí výchozí model",
		widget: "zobrazí/skryje stavový widget nad editorem (on|off|toggle)",
		help: "zobrazí podrobnou nápovědu a pořadí modelů",
	};

	const showZenHelp = (ctx: ExtensionContext) => {
		const now = Date.now();
		const cooling = [...state.failedUntil]
			.filter(([, until]) => until > now)
			.map(([id, until]) => {
				const secs = Math.max(1, Math.round((until - now) / 1000));
				return `${id} (${Math.floor(secs / 60)}m ${secs % 60}s)`;
			});
		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "žádný";
		ctx.ui.notify(
			[
				`pi-zen-fallback — stav: ${state.enabled ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"}`,
				"Automatické přepínání mezi bezplatnými modely OpenCode Zen při vyčerpání limitu (HTTP 429).",
				"",
				"Příkazy:",
				"/zen                    — tato nápověda + stav",
				"/zen on|off             — zapne / vypne auto-fallback",
				"/zen toggle             — přepne stav zapnuto/vypnuto",
				"/zen reset              — vymaže cooldowny a vrátí výchozí model",
				"/zen widget [on|off]    — zapne/vypne detailní widget nad editorem",
				"/zen status             — zobrazí rychlý stav",
				"",
				`Aktivní model: ${model}${isOnFallbackModel(ctx.model?.id) ? " (fallback)" : ""}`,
				`Chladnoucí modely (${cooling.length}): ${cooling.join(", ") || "žádné"}`,
				`Widget nad editorem: ${widgetVisible ? "zobrazen" : "skryt"}`,
				`Pořadí fallbacku: ${FALLBACK_ORDER.join(" → ")}`,
			].join("\n"),
			"info",
		);
	};

	pi.registerCommand("zen", {
		description:
			"pi-zen-fallback: auto-fallback mezi bezplatnými OpenCode Zen modely při rate-limitu",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);
			const normalizedPrefix = tokens.join(" ").toLowerCase();

			// Druhé slovo — např. /zen widget on|off|toggle
			if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
				const cmd = tokens[0]?.toLowerCase();

				if (cmd === "widget") {
					const items = [
						{
							value: "widget on",
							label: "widget on",
							description: "zobrazit widget nad editorem",
						},
						{
							value: "widget off",
							label: "widget off",
							description: "skrýt widget",
						},
						{
							value: "widget toggle",
							label: "widget toggle",
							description: "přepnout zobrazení widgetu",
						},
					];
					const filtered = items.filter((i) =>
						i.value.toLowerCase().startsWith(normalizedPrefix),
					);
					return filtered.length > 0 ? filtered : null;
				}
				return null;
			}

			// První slovo — podpříkazy
			const typed = (tokens[0] ?? "").toLowerCase();
			const items = Object.entries(ZEN_DOCS)
				.filter(([key]) => key.startsWith(typed))
				.map(([value, description]) => ({ value, label: value, description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subRaw?.toLowerCase();
			const arg = rest[0]?.toLowerCase();

			if (!sub || sub === "help" || sub === "status") {
				showZenHelp(ctx);
				refreshStatus(ctx);
				refreshWidget(ctx);
				return;
			}

			if (sub === "on") {
				state.enabled = true;
				ctx.ui.notify("Zen auto-fallback: ZAPNUTO (ON)", "info");
				refreshStatus(ctx);
				refreshWidget(ctx);
				return;
			}

			if (sub === "off") {
				state.enabled = false;
				ctx.ui.notify("Zen auto-fallback: VYPNUTO (OFF)", "info");
				refreshStatus(ctx);
				refreshWidget(ctx);
				return;
			}

			if (sub === "toggle") {
				state.enabled = !state.enabled;
				ctx.ui.notify(`Zen auto-fallback: ${state.enabled ? "ON" : "OFF"}`, "info");
				refreshStatus(ctx);
				refreshWidget(ctx);
				return;
			}

			if (sub === "reset") {
				state.failedUntil.clear();
				state.lastSwitchAt = 0;
				const defaultModel = ctx.modelRegistry.find(
					ZEN_PROVIDER,
					FALLBACK_ORDER[0],
				);
				if (defaultModel) {
					await pi.setModel(defaultModel);
					ctx.ui.notify(
						`Zen resetován → výchozí model: ${FALLBACK_ORDER[0]}`,
						"info",
					);
				} else {
					ctx.ui.notify("Zen cooldowny vymazány.", "info");
				}
				refreshStatus(ctx);
				refreshWidget(ctx);
				return;
			}

			if (sub === "widget") {
				if (arg === "on") widgetVisible = true;
				else if (arg === "off") widgetVisible = false;
				else widgetVisible = !widgetVisible;

				if (widgetVisible) {
					refreshWidget(ctx);
					ctx.ui.notify("Zen widget zobrazen", "info");
				} else {
					try {
						ctx.ui.setWidget(WIDGET_KEY, undefined);
					} catch {
						/* ignore */
					}
					ctx.ui.notify("Zen widget skryt", "info");
				}
				return;
			}

			ctx.ui.notify(
				"Neznámý příkaz. Použijte: /zen [on|off|toggle|reset|widget|status|help]",
				"warning",
			);
		},
	});

	pi.registerCommand("zen-status", {
		description: "Zobrazit stav fallbacku mezi bezplatnými modely OpenCode Zen",
		getArgumentCompletions: () => null,
		handler: (_args, ctx) => {
			showZenHelp(ctx);
			refreshStatus(ctx);
			refreshWidget(ctx);
		},
	});

	pi.registerCommand("zen-reset", {
		description: "Resetovat vyčerpané modely a vrátit výchozí model Zen",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			state.failedUntil.clear();
			state.lastSwitchAt = 0;
			const defaultModel = ctx.modelRegistry.find(ZEN_PROVIDER, FALLBACK_ORDER[0]);
			if (defaultModel) {
				await pi.setModel(defaultModel);
				ctx.ui.notify(
					`Zen stav resetován → výchozí model: ${FALLBACK_ORDER[0]}`,
					"info",
				);
			} else {
				ctx.ui.notify("Zen cooldowny vymazány (výchozí model nenalezen).", "info");
			}
			refreshStatus(ctx);
			refreshWidget(ctx);
		},
	});

	pi.registerCommand("zen-toggle", {
		description: "Zapnout nebo vypnout zen auto-fallback pro tento proces",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);
			if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
				return null;
			}
			const items = [
				{ value: "on", label: "on", description: "zapnout fallback" },
				{ value: "off", label: "off", description: "vypnout fallback" },
			];
			const filtered = items.filter((i) =>
				i.value.startsWith(prefix.trim().toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") state.enabled = true;
			else if (arg === "off") state.enabled = false;
			else state.enabled = !state.enabled;

			ctx.ui.notify(
				`Zen auto-fallback: ${state.enabled ? "ZAPNUTO (ON)" : "VYPNUTO (OFF)"}`,
				"info",
			);
			refreshStatus(ctx);
			refreshWidget(ctx);
		},
	});

	pi.registerCommand("zen-widget", {
		description: "Přepnout zobrazení detailního widgetu nad editorem",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);
			if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
				return null;
			}
			const items = [
				{ value: "on", label: "on", description: "zobrazit widget" },
				{ value: "off", label: "off", description: "skrýt widget" },
				{ value: "toggle", label: "toggle", description: "přepnout widget" },
			];
			const filtered = items.filter((i) =>
				i.value.startsWith(prefix.trim().toLowerCase()),
			);
			return filtered.length > 0 ? filtered : null;
		},
		handler: (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") widgetVisible = true;
			else if (arg === "off") widgetVisible = false;
			else widgetVisible = !widgetVisible;

			if (widgetVisible) {
				refreshWidget(ctx);
				ctx.ui.notify("Zen widget zobrazen", "info");
			} else {
				try {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
				} catch {
					/* ignore */
				}
				ctx.ui.notify("Zen widget skryt", "info");
			}
		},
	});
}
