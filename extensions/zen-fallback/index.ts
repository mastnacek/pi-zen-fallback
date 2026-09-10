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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
// NOTE: Zen is NOT a single protocol. The Muse Spark free models speak the
// OpenAI Responses API (POST /responses); the rest speak OpenAI Chat
// Completions (POST /chat/completions). Sending a Spark model to
// /chat/completions makes the gateway answer HTTP 500 "Internal server
// error" — so every model below carries its own `api` in FREE_MODELS,
// mirroring pi's built-in `opencode` provider catalog.
// Manual refresh vs https://opencode.ai/zen/v1/models — 2026-09-10.
let FALLBACK_ORDER = [
	"mimo-v2.5-free",
	"big-pickle",
	"ling-3.0-flash-fin-free",
	"nemotron-3-ultra-free",
	"nemotron-3.5-lightning-free",
	"muse-spark-1.3-contributor-free",
	"muse-spark-1.2-contributor-free",
	"deepseek-v4-flash-free",
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
//
// Every entry carries its own `api` + `compat`, mirroring pi's built-in
// `opencode` provider catalog:
// - Chat Completions models must NOT receive `store:true`, the `developer`
//   role, or `max_completion_tokens` — the Zen gateway answers those with
//   HTTP 500, hence CHAT_COMPLETIONS_COMPAT.
// - Muse Spark free models speak the Responses API (wrong endpoint = HTTP
//   500 "Internal server error"), hence `api: "openai-responses"`.
// Manual refresh vs https://opencode.ai/zen/v1/models — 2026-09-10.
const CHAT_COMPLETIONS_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
} as const;

const RESPONSES_COMPAT = {
	sessionAffinityFormat: "openai-nosession",
} as const;

const FREE_MODELS = [
	{
		id: "mimo-v2.5-free",
		name: "MiMo V2.5 Free",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text", "image"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: CHAT_COMPLETIONS_COMPAT,
	},
	{
		id: "big-pickle",
		name: "Big Pickle (free)",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: CHAT_COMPLETIONS_COMPAT,
	},
	{
		id: "ling-3.0-flash-fin-free",
		name: "Ling 3.0 Flash Fin Free",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
		compat: CHAT_COMPLETIONS_COMPAT,
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 128000,
		compat: CHAT_COMPLETIONS_COMPAT,
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 262144,
		compat: CHAT_COMPLETIONS_COMPAT,
	},
	{
		id: "muse-spark-1.3-contributor-free",
		name: "Muse Spark 1.3 Free",
		reasoning: true,
		api: "openai-responses" as const,
		input: ["text", "image"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
		compat: RESPONSES_COMPAT,
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	},
	{
		id: "muse-spark-1.2-contributor-free",
		name: "Muse Spark 1.2 Free",
		reasoning: true,
		api: "openai-responses" as const,
		input: ["text", "image"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
		compat: RESPONSES_COMPAT,
		thinkingLevelMap: {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	},
	{
		// Legacy entry: still listed by /v1/models, but no longer in pi's
		// curated catalog or the Zen docs table — kept last as fallback.
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash Free",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
		compat: CHAT_COMPLETIONS_COMPAT,
	},
];

const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

/* ------------------------------------------------------------------ */
/* Manual catalogue refresh from the OpenCode Zen gateway              */
/* ------------------------------------------------------------------ */

const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ZEN_CACHE_FILE = "zen-free-models.cache.json";

type ZenFreeModel = (typeof FREE_MODELS)[number];

function zenAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function zenCachePath(): string {
	return join(zenAgentDir(), ZEN_CACHE_FILE);
}

// Pretty-name an unknown model id, e.g. "north-mini-code-free" → "North Mini Code Free".
function prettifyModelId(id: string): string {
	if (id === "big-pickle") return "Big Pickle (free)";
	return (
		id
			.replace(/-free$/, "")
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ") + " Free"
	);
}

// Build provider-model entries for a given priority order. Known ids reuse
// the embedded catalogue verbatim (correct `api`/`compat` included); brand
// new gateway ids default to Chat Completions, which is what all current
// free models except Muse Spark speak.
function toProviderModels(orderedIds: string[]): ZenFreeModel[] {
	return orderedIds.map((id) => {
		const embedded = FREE_MODELS.find((m) => m.id === id);
		if (embedded) return { ...embedded };
		return {
			id,
			name: prettifyModelId(id),
			reasoning: true,
			api: "openai-completions" as const,
			input: ["text"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32768,
			compat: CHAT_COMPLETIONS_COMPAT,
		};
	});
}

// Fetch the live /v1/models catalog from the zen gateway and return free-model
// ids in stable priority order: embedded/known order first, then new models the
// gateway now serves (appended in gateway order). Throws on network failure.
async function fetchOrderedZenFreeIds(): Promise<string[]> {
	const res = await fetch(ZEN_MODELS_URL, {
		headers: { "user-agent": ZEN_DEFAULT_UA },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { data?: { id: string }[] };
	const live = data.data ?? [];
	const liveSet = new Set(live.map((m) => m.id));
	const free = live
		.map((m) => m.id)
		.filter((id) => id === "big-pickle" || id.endsWith("-free"));

	const ordered: string[] = [];
	for (const id of FALLBACK_ORDER) if (liveSet.has(id)) ordered.push(id);
	for (const id of free) if (!ordered.includes(id)) ordered.push(id);
	return ordered;
}

// Persisted catalogue (written by /zen refresh). Cache wins over the embedded
// list on startup so a manual refresh survives /reload; entries without a
// valid shape are dropped.
function readCachedModels(): ZenFreeModel[] | null {
	try {
		const raw = JSON.parse(readFileSync(zenCachePath(), "utf8")) as {
			fetchedAt?: number;
			models?: ZenFreeModel[];
		};
		if (!Array.isArray(raw.models) || raw.models.length === 0) return null;
		const upgraded: ZenFreeModel[] = [];
		for (const m of raw.models) {
			if (!m || typeof m.id !== "string" || typeof m.name !== "string") {
				continue;
			}
			// Known ids always use the embedded catalogue, so an old cache
			// (written before per-model `api`/`compat` existed) can never
			// re-register a Responses model as Chat Completions.
			const embedded = FREE_MODELS.find((k) => k.id === m.id);
			if (embedded) {
				upgraded.push({ ...embedded });
				continue;
			}
			if (
				m.api === "openai-responses" ||
				m.api === "openai-completions"
			) {
				upgraded.push(m);
			} else {
				upgraded.push({ ...toProviderModels([m.id])[0] });
			}
		}
		return upgraded.length > 0 ? upgraded : null;
	} catch {
		return null; // no cache / unreadable — use embedded catalogue
	}
}

function writeZenCache(models: ZenFreeModel[]): void {
	try {
		const tmp = `${zenCachePath()}.tmp`;
		writeFileSync(
			tmp,
			JSON.stringify({ fetchedAt: Date.now(), models }, null, 2),
			"utf8",
		);
		renameSync(tmp, zenCachePath());
	} catch {
		/* non-fatal: refresh still applies for this process */
	}
}
const ZEN_DEFAULT_UA =
	"opencode/1.18.30 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

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
		// Provider-level default only: entries in FREE_MODELS carry their own
		// per-model `api` (Muse Spark → "openai-responses"), which wins.
		// NOTE: pi itself attaches `x-opencode-session` / `x-opencode-client`
		// to every opencode.ai request — without them the free tier answers
		// "OpenCode's free tier can only be used in OpenCode".
		api: existing?.api ?? "openai-completions",
		apiKey: existing?.apiKey ?? "public",
		headers: existing?.headers ?? { "user-agent": ZEN_DEFAULT_UA },
		models: readCachedModels() ?? FREE_MODELS,
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
		Boolean(modelId) &&
		modelId !== FALLBACK_ORDER[0] &&
		FALLBACK_ORDER.includes(modelId)
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
		refresh: "stáhne aktuální seznam free modelů z OpenCode Zen brány (ručně)",
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
				"/zen refresh            — stáhne aktuální free modely z brány (ruční aktualizace)",
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

			if (sub === "refresh") {
				try {
					ctx.ui.notify(
						"Zen: stahuji aktuální seznam free modelů z opencode.ai/zen ...",
						"info",
					);
					const orderedIds = await fetchOrderedZenFreeIds();
					if (orderedIds.length === 0) {
						ctx.ui.notify(
							"Zen: brána nevrátila žádný free model — seznam se nezměnil.",
							"warning",
						);
						return;
					}
					const models = toProviderModels(orderedIds);
					writeZenCache(models);

					// Live re-register for THIS process; cache file carries the
					// update across /reload (read again in ensureZenProviderRegistered).
					FALLBACK_ORDER = orderedIds;
					const existing = readZenfreeConfigFromModelsJson();
					ctx.modelRegistry.registerProvider(ZEN_PROVIDER, {
						name: "OpenCode Zen (free)",
						baseUrl: existing?.baseUrl ?? ZEN_DEFAULT_BASE_URL,
						api: existing?.api ?? "openai-completions",
						apiKey: existing?.apiKey ?? "public",
						headers: existing?.headers ?? { "user-agent": ZEN_DEFAULT_UA },
						models,
					});
					await ctx.modelRegistry.refresh({
						allowNetwork: false,
						providers: [ZEN_PROVIDER],
					});

					const current = ctx.model?.id;
					const stillActive = orderedIds.includes(current ?? "");
					ctx.ui.notify(
						[
							`Zen: seznam aktualizován (${orderedIds.length} free modelů).`,
							`Pořadí: ${orderedIds.join(" → ")}`,
							stillActive
								? `Aktivní model ${current} zůstává.`
								: `Aktivní model ${current ?? "?"} už není v seznamu — použijte /zen reset.`,
						].join("\n"),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`Zen: aktualizace selhala — ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				refreshStatus(ctx);
				refreshWidget(ctx);
				return;
			}

			ctx.ui.notify(
				"Neznámý příkaz. Použijte: /zen [on|off|toggle|reset|widget|refresh|status|help]",
				"warning",
			);
		},
	});

	pi.registerCommand("zen-status", {
		description: "Zobrazit stav fallbacku mezi bezplatnými modely OpenCode Zen",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			showZenHelp(ctx);
			refreshStatus(ctx);
			refreshWidget(ctx);
		},
	});

	pi.registerCommand("zen-refresh", {
		description: "Stáhnout aktuální seznam free modelů z OpenCode Zen brány",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(
					"Zen: stahuji aktuální seznam free modelů z opencode.ai/zen ...",
					"info",
				);
				const orderedIds = await fetchOrderedZenFreeIds();
				if (orderedIds.length === 0) {
					ctx.ui.notify(
						"Zen: brána nevrátila žádný free model — seznam se nezměnil.",
						"warning",
					);
					return;
				}
				const models = toProviderModels(orderedIds);
				writeZenCache(models);
				FALLBACK_ORDER = orderedIds;
				const existing = readZenfreeConfigFromModelsJson();
				ctx.modelRegistry.registerProvider(ZEN_PROVIDER, {
					name: "OpenCode Zen (free)",
					baseUrl: existing?.baseUrl ?? ZEN_DEFAULT_BASE_URL,
					api: existing?.api ?? "openai-completions",
					apiKey: existing?.apiKey ?? "public",
					headers: existing?.headers ?? { "user-agent": ZEN_DEFAULT_UA },
					models,
				});
				await ctx.modelRegistry.refresh({
					allowNetwork: false,
					providers: [ZEN_PROVIDER],
				});
				ctx.ui.notify(
					`Zen: seznam aktualizován (${orderedIds.length} free modelů): ${orderedIds.join(" → ")}`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(
					`Zen: aktualizace selhala — ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
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
		handler: async (args, ctx) => {
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
		handler: async (args, ctx) => {
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
