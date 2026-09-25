/**
 * The zen gateway catalogue: free-model metadata, the fallback order (mutable, so
 * it lives on a const object) and the timing/threshold constants.
 */


export const ZEN_PROVIDER = "zenfree";

export const ZEN_BASE_URL_MARKER = "opencode.ai/zen";

export const TRIGGER_STATUSES = new Set([429, 502, 503]);

/**
 * Auth/gate rejections: the free tier answers 403 to every non-opencode client
 * (proved by capture tests — headers are identical, only the client transport
 * differs) and 401 to a bad API key. No other free model will succeed either,
 * so these must never trigger a model switch.
 */
export const AUTH_STATUSES = new Set([401, 403]);

/** Still listed by /v1/models but already deprecated — never offer them. */
export const DEPRECATED_FREE_IDS = new Set([
	"mimo-v2.5-free",
	"deepseek-v4-flash-free",
	"muse-spark-1.2-contributor-free",
]);

/** Free-looking ids that are not chat models (Jev uses the /systemone API). */
export const NON_CHAT_FREE_IDS = new Set(["jev-1.13-free"]);

export const FAIL_COOLDOWN_MS = 10 * 60 * 1000;

export const SWITCH_COOLDOWN_MS = 30 * 1000;

export const CHAT_COMPLETIONS_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
} as const;

export const RESPONSES_COMPAT = {
	sessionAffinityFormat: "openai-nosession",
} as const;

export const FREE_MODELS = [
	{
		id: "mimo-v2.6-flash-free",
		name: "MiMo V2.6 Flash Free",
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
		id: "space-bunny-free",
		name: "Space Bunny Free",
		reasoning: true,
		api: "openai-completions" as const,
		input: ["text", "image"] as Array<"text" | "image">,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
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
];

export const ZEN_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

export const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

export const ZEN_CACHE_FILE = "zen-free-models.cache.json";

export type ZenFreeModel = (typeof FREE_MODELS)[number];

/** The fallback order. A property, not a `let`: the commands reassign it. */
export const zenCatalog: { order: string[] } = {
  order: [
	"mimo-v2.6-flash-free",
	"big-pickle",
	"space-bunny-free",
	"ling-3.0-flash-fin-free",
	"nemotron-3.5-lightning-free",
	"nemotron-3-ultra-free",
	"muse-spark-1.3-contributor-free",
  ],
};
