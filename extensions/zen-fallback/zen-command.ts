/**
 * The `/zen` command: catalogue listing and manual switching.
 * Split out of `index.ts`; the definitions are unchanged, only wrapped in a function.
 */
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { ZEN_PROVIDER, ZEN_DEFAULT_BASE_URL, zenCatalog } from "./zen-data.ts";
import { toProviderModels, fetchOrderedZenFreeIds, writeZenCache, ZEN_DEFAULT_UA, readZenfreeConfigFromModelsJson, ensureZenProviderRegistered } from "./zen-cache.ts";
import { state, WIDGET_KEY, isOnFallbackModel, refreshStatus, refreshWidget, zenStatus } from "./zen-status.ts";

export function registerZenCommand(pi: ExtensionAPI): void {
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
			`Widget nad editorem: ${zenStatus.widgetVisible ? "zobrazen" : "skryt"}`,
			`Pořadí fallbacku: ${zenCatalog.order.join(" → ")}`,
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
		const NON_TERMINAL = new Set(["widget"]);
		const items: AutocompleteItem[] = [];
		for (const [key, description] of Object.entries(ZEN_DOCS)) {
			if (key.toLowerCase().startsWith(typed)) {
				items.push({
					value: NON_TERMINAL.has(key) ? `${key} ` : key,
					label: key,
					description,
				});
			}
		}
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
				zenCatalog.order[0],
			);
			if (defaultModel) {
				await pi.setModel(defaultModel);
				ctx.ui.notify(
					`Zen resetován → výchozí model: ${zenCatalog.order[0]}`,
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
			if (arg === "on") zenStatus.widgetVisible = true;
			else if (arg === "off") zenStatus.widgetVisible = false;
			else zenStatus.widgetVisible = !zenStatus.widgetVisible;

			if (zenStatus.widgetVisible) {
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
				zenCatalog.order = orderedIds;
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
}
