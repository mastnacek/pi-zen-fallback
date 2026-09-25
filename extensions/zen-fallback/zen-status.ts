/**
 * Shared extension state and the status-line/widget renderers.
 */
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ZEN_PROVIDER, ZEN_BASE_URL_MARKER, zenCatalog } from "./zen-data.ts";

export interface ZenState {
	enabled: boolean;
	failedUntil: Map<string, number>; // modelId -> timestamp after which it may be tried again
	lastSwitchAt: number;
	lastRequestModelId: string | null; // model id of the most recent provider request
	authNoticeAt: number; // last 401/403 notification (dedupes a spammy error)
}

export const state: ZenState = {
	enabled: true,
	failedUntil: new Map(),
	lastSwitchAt: 0,
	lastRequestModelId: null,
	authNoticeAt: 0,
};

export const STATUS_KEY = "zen-fallback";

export const WIDGET_KEY = "zen-fallback-detail";

export function isOnFallbackModel(modelId: string | undefined): boolean {
	return (
		Boolean(modelId) &&
		modelId !== zenCatalog.order[0] &&
		zenCatalog.order.includes(modelId)
	);
}

export function isZenProvider(
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

export function formatStatus(
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

	if (!zenStatus.keyConfigured) parts.push(theme.fg("warning", "BEZ-KLÍČE"));

	if (current) {
		parts.push(theme.fg("text", current));
		if (isOnFallbackModel(current)) parts.push(theme.fg("warning", "(fb)"));
	}
	if (cooling > 0) parts.push(theme.fg("warning", `⏳${cooling}`));

	return parts.join(" ");
}

export function refreshStatus(
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

export function refreshWidget(
	ctx: ExtensionContext,
	targetModel?: { provider?: string; id?: string },
): void {
	if (!zenStatus.widgetVisible) return;
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

/** Widget visibility. A property, not a `let`: the commands toggle it. */
export const zenStatus: { widgetVisible: boolean; keyConfigured: boolean; keySource: string } = {
  widgetVisible: false,
  // Flipped by zen-cache when a real Zen API key is found. Without a key the
  // gateway answers 403 to every free model (free tier is opencode-only).
  keyConfigured: false,
  keySource: "",
};
