/**
 * The five small `/zen-*` commands (status, refresh, reset, toggle, widget).
 * Split out of `index.ts`; the definitions are unchanged, only wrapped in a function.
 */
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ZEN_PROVIDER, zenCatalog } from "./zen-data.ts";
import { toProviderModels, fetchOrderedZenFreeIds, writeZenCache, buildZenProviderConfig } from "./zen-cache.ts";
import { state, WIDGET_KEY, isOnFallbackModel, refreshStatus, refreshWidget, zenStatus } from "./zen-status.ts";

export function registerZenCommands(pi: ExtensionAPI): void {
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
			`API klíč: ${
				zenStatus.keyConfigured
					? `nastaven (${zenStatus.keySource})`
					: "CHYBÍ — free tier je jen pro opencode, klíč: https://opencode.ai/auth → ZEN_API_KEY"
			}`,
			`Widget nad editorem: ${zenStatus.widgetVisible ? "zobrazen" : "skryt"}`,
			`Pořadí fallbacku: ${zenCatalog.order.join(" → ")}`,
		].join("\n"),
		"info",
	);
};

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
			zenCatalog.order = orderedIds;
			ctx.modelRegistry.registerProvider(
				ZEN_PROVIDER,
				buildZenProviderConfig(models),
			);
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
		const defaultModel = ctx.modelRegistry.find(ZEN_PROVIDER, zenCatalog.order[0]);
		if (defaultModel) {
			await pi.setModel(defaultModel);
			ctx.ui.notify(
				`Zen stav resetován → výchozí model: ${zenCatalog.order[0]}`,
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
	},
});
}
