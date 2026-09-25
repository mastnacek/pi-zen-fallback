# pi-zen-fallback

Auto-fallback between the **free OpenCode Zen models** for the [pi coding agent](https://github.com/earendil-works/pi). When the model pi is currently using hits its free-tier rate limit (HTTP 429 / `FreeUsageLimitError`), this extension switches to the next available free model — so work continues without manual intervention.

> **Scope:** This extension only ever touches the `zenfree` provider. If you add paid models from other providers, they are never switched, skipped, or otherwise modified.

## Features

- **Auto-fallback on rate limit** — reacts to HTTP 429/502/503 from the zen gateway and walks a priority list of free models.
- **Per-model cooldown** — an exhausted model is skipped for 10 minutes so it can recover and be reused, instead of being burned forever.
- **Anti-thrashing** — at most one automatic switch per 30 seconds.
- **API-key aware** — the Zen free tier rejects every client that is not opencode itself (HTTP 403), so the extension reads your Zen key from `ZEN_API_KEY` / `OPENCODE_API_KEY` (or `models.json`) and explains exactly what to do when 401/403 comes back instead of pointlessly switching models.
- **Self-registration on clean installs** — on a fresh pi (no `models.json`) the extension registers the `zenfree` provider and all free models by itself. If you already configured `zenfree` in `models.json`, your configuration is left completely untouched.
- **Strict provider gating** — only acts when the active model's provider id is `zenfree` *and* its base URL points at `opencode.ai/zen`.
- **Status line & widget** — shows `zen:ON/OFF · <model> · ⏳<cooldown>` in the footer, plus an optional detailed widget above the editor.
- **Small-model safe** — session title / summarizer calls that use a different model never trigger a fallback.

## API key (required)

The Zen free tier answers `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode` to every client except opencode itself — a byte-for-byte copy of opencode's request headers is still rejected, so header spoofing cannot fix it. A real Zen API key bypasses that gate.

1. Create a key at <https://opencode.ai/auth>.
2. Export it before starting pi, either as `ZEN_API_KEY` or `OPENCODE_API_KEY`:

```bash
export ZEN_API_KEY="zk_..."
pi
```

Alternatively put `apiKey` into the `zenfree` provider block in `~/.pi/agent/models.json` — that value always wins. `/zen status` shows which source was picked (`API klíč: nastaven (env ZEN_API_KEY)`), the status line shows `BEZ-KLÍČE` when none was found.

## Installation

Requires pi. Install from git:

```bash
pi install git:github.com/mastnacek/pi-zen-fallback
```

Or, to try it without installing:

```bash
pi -e git:github.com/mastnacek/pi-zen-fallback
```

After installing, run `/reload` in pi to pick up the extension.

### What it registers on a clean pi

If you don't already have a `zenfree` provider in `~/.pi/agent/models.json`, the extension registers it with:

- `baseUrl`: `https://opencode.ai/zen/v1`
- `apiKey`: your key from `ZEN_API_KEY` / `OPENCODE_API_KEY`, otherwise `public` (anonymous — rejected with 403)
- `headers.user-agent`: `opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`

and these free models (in fallback priority order):

| Priority | Model | Protokol |
| ---------- | ------- | -------- |
| 1 | `mimo-v2.6-flash-free` | Chat Completions |
| 2 | `big-pickle` | Chat Completions |
| 3 | `space-bunny-free` | Chat Completions |
| 4 | `ling-3.0-flash-fin-free` | Chat Completions |
| 5 | `nemotron-3.5-lightning-free` | Chat Completions |
| 6 | `nemotron-3-ultra-free` | Chat Completions |
| 7 | `muse-spark-1.3-contributor-free` | Responses (`/v1/responses`) |

> Zen není jeden protokol: většina free modelů mluví OpenAI Chat Completions,
> ale Muse Spark free modely mluví OpenAI Responses API. Plugin proto každému
> modelu registruje vlastní `api` + `compat` (stejně jako vestavěný `opencode`
> provider v pi) — poslat Spark na `/chat/completions` vrací HTTP 500.

> Retired ids (`mimo-v2.5-free`, `deepseek-v4-flash-free`,
> `muse-spark-1.2-contributor-free`) and the non-chat `jev-1.13-free`
> (`/v1/systemone`) are filtered out of `/zen refresh` results even though the
> gateway still lists them. Model list last refreshed manually vs
> `https://opencode.ai/zen/v1/models` on 2026-09-25.

If `models.json` already defines `zenfree` with models, the extension **defers to your configuration** and registers nothing.

## Commands

| Command | Description |
| --------- | ------------- |
| `/zen-status` | Show fallback state: on/off, active model, models cooling down |
| `/zen-reset` | Clear exhausted-model marks and return to the default model (`mimo-v2.6-flash-free`) |
| `/zen-toggle` | Enable/disable auto-fallback for this process |
| `/zen-widget` | Toggle the detailed fallback widget above the editor |
| `/zen-refresh` | Manually re-fetch the free model list from the OpenCode Zen gateway (`https://opencode.ai/zen/v1/models`) and re-register it live; result is cached so it survives `/reload` |
| `/zen refresh` | Same action as a subcommand of the `/zen` menu |

## How it works

1. `before_provider_request` records which model the outgoing request targets.
2. `after_provider_response` checks the HTTP status of the response.
3. If the status is 429/502/503, the active model belongs to `zenfree`, and the failed request was for the active model (not a small-model call), the extension picks the next model in the priority list that is not in cooldown and calls `pi.setModel(...)`.
4. The exhausted model is marked as failed for 10 minutes; the switch is rate-limited to one per 30 seconds.

Pi's built-in transient-error retry then re-runs the request with the newly selected model.

## Uninstall

```bash
pi remove git:github.com/mastnacek/pi-zen-fallback
```

## License

MIT
