/**
 * Catalogue resolution: where the cache lives, how the model list is built and
 * refreshed, and how the zenfree provider gets registered.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CHAT_COMPLETIONS_COMPAT, DEPRECATED_FREE_IDS, FREE_MODELS, NON_CHAT_FREE_IDS, ZEN_DEFAULT_BASE_URL, ZEN_MODELS_URL, ZEN_CACHE_FILE, type ZenFreeModel, zenCatalog } from "./zen-data.ts";
import { zenStatus } from "./zen-status.ts";

export function zenAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function zenCachePath(): string {
	return join(zenAgentDir(), ZEN_CACHE_FILE);
}

export function prettifyModelId(id: string): string {
	if (id === "big-pickle") return "Big Pickle (free)";
	return (
		id
			.replace(/-free$/, "")
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ") + " Free"
	);
}

export function toProviderModels(orderedIds: string[]): ZenFreeModel[] {
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

export async function fetchOrderedZenFreeIds(): Promise<string[]> {
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
		.filter(
			(id) =>
				(id === "big-pickle" || id.endsWith("-free")) &&
				!DEPRECATED_FREE_IDS.has(id) &&
				!NON_CHAT_FREE_IDS.has(id),
		);

	const ordered: string[] = [];
	for (const id of zenCatalog.order) if (liveSet.has(id)) ordered.push(id);
	for (const id of free) if (!ordered.includes(id)) ordered.push(id);
	return ordered;
}

export function readCachedModels(): ZenFreeModel[] | null {
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
				upgraded.push({ ...toProviderModels([(m as { id: string }).id])[0] });
			}
		}
		// An old cache can still carry deprecated / non-chat ids — drop them so
		// a stale file never re-registers a model the gateway has retired.
		const usable = upgraded.filter(
			(m) => !DEPRECATED_FREE_IDS.has(m.id) && !NON_CHAT_FREE_IDS.has(m.id),
		);
		// A cache written before a new model shipped must not hide it: append any
		// embedded entry the file predates, in catalogue order.
		for (const embedded of FREE_MODELS) {
			if (!usable.some((m) => m.id === embedded.id)) usable.push({ ...embedded });
		}
		return usable.length > 0 ? usable : null;
	} catch {
		return null; // no cache / unreadable — use embedded catalogue
	}
}

export function writeZenCache(models: ZenFreeModel[]): void {
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

export const ZEN_DEFAULT_UA =
	"opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

/** Env vars checked for a Zen API key, in order of precedence. */
export const ZEN_KEY_ENVS = ["ZEN_API_KEY", "OPENCODE_API_KEY"] as const;

export const ZEN_KEY_DOCS = "https://opencode.ai/auth";

/**
 * Resolve the API key for the zenfree provider.
 *
 * The free tier rejects every client that is not opencode itself — a byte-for-byte
 * copy of opencode's headers still gets HTTP 403 (only its own transport passes),
 * so a real Zen key is the only way to call these models from pi. `models.json`
 * wins over the environment (handled by the caller); without any key we keep the
 * legacy anonymous value and let `zenStatus.keyConfigured` surface the problem.
 */
export function resolveZenApiKey(): { apiKey: string; source: string } {
	for (const name of ZEN_KEY_ENVS) {
		const value = process.env[name];
		if (value && value.trim()) {
			return { apiKey: value.trim(), source: `env ${name}` };
		}
	}
	return { apiKey: "public", source: "" };
}

/** Provider registration payload + key bookkeeping (shared by every register path). */
export function buildZenProviderConfig(models: ZenFreeModel[]) {
	const existing = readZenfreeConfigFromModelsJson();
	const resolved = resolveZenApiKey();
	const apiKey = existing?.apiKey ?? resolved.apiKey;
	zenStatus.keyConfigured = apiKey !== "public";
	zenStatus.keySource = existing?.apiKey ? "models.json" : resolved.source;
	return {
		name: "OpenCode Zen (free)",
		baseUrl: existing?.baseUrl ?? ZEN_DEFAULT_BASE_URL,
		// Provider-level default only: entries in FREE_MODELS carry their own
		// per-model `api` (Muse Spark → "openai-responses"), which wins.
		api: existing?.api ?? "openai-completions",
		apiKey,
		headers: existing?.headers ?? { "user-agent": ZEN_DEFAULT_UA },
		models,
	};
}

export function ensureZenProviderRegistered(pi: ExtensionAPI): void {
	const existing = readZenfreeConfigFromModelsJson();
	const models = readCachedModels() ?? FREE_MODELS;
	// Always compute key state, even when the user's own config wins — the
	// status line and the 401/403 handler depend on it.
	const config = buildZenProviderConfig(models);
	if (existing?.hasModels) return; // user config wins — never clobber it
	pi.registerProvider("zenfree", config);
}

export function readZenfreeConfigFromModelsJson() {
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
