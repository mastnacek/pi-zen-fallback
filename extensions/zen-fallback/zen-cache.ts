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
import { CHAT_COMPLETIONS_COMPAT, FREE_MODELS, ZEN_DEFAULT_BASE_URL, ZEN_MODELS_URL, ZEN_CACHE_FILE, type ZenFreeModel, zenCatalog } from "./zen-data.ts";

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
		.filter((id) => id === "big-pickle" || id.endsWith("-free"));

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
		return upgraded.length > 0 ? upgraded : null;
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
	"opencode/1.18.30 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14";

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

export function ensureZenProviderRegistered(pi: ExtensionAPI): void {
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
