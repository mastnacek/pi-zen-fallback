# pi-zen-fallback

Auto-fallback between the **free OpenCode Zen models** for the [pi coding agent](https://github.com/earendil-works/pi). When the model pi is currently using hits its free-tier rate limit (HTTP 429 / `FreeUsageLimitError`), this extension switches to the next available free model — so work continues without manual intervention.

> **Scope:** This extension only ever touches the `zenfree` provider. If you add paid models from other providers, they are never switched, skipped, or otherwise modified.

## Features

- **Auto-fallback on rate limit** — reacts to HTTP 429/502/503 from the zen gateway and walks a priority list of free models.
- **Per-model cooldown** — an exhausted model is skipped for 10 minutes so it can recover and be reused, instead of being burned forever.
- **Anti-thrashing** — at most one automatic switch per 30 seconds.
- **Self-registration on clean installs** — on a fresh pi (no `models.json`) the extension registers the `zenfree` provider and all free models by itself. If you already configured `zenfree` in `models.json`, your configuration is left completely untouched.
- **Strict provider gating** — only acts when the active model's provider id is `zenfree` *and* its base URL points at `opencode.ai/zen`.
- **Status line & widget** — shows `zen:ON/OFF · <model> · ⏳<cooldown>` in the footer, plus an optional detailed widget above the editor.
- **Small-model safe** — session title / summarizer calls that use a different model never trigger a fallback.

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
- `apiKey`: `public`
- `headers.user-agent`: `opencode/1.18.18 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`

and these free models (in fallback priority order):

| Priority | Model |
| ---------- | ------- |
| 1 | `deepseek-v4-flash-free` |
| 2 | `nemotron-3.5-lightning-free` |
| 3 | `mimo-v2.5-free` |
| 4 | `nemotron-3-ultra-free` |
| 5 | `big-pickle` |
| 6 | `ling-3.0-flash-fin-free` |
| 7 | `muse-spark-1.2-contributor-free` |
| 8 | `muse-spark-1.3-contributor-free` |

> Model list last refreshed manually vs `https://opencode.ai/zen/v1/models` on 2026-09-10.

If `models.json` already defines `zenfree` with models, the extension **defers to your configuration** and registers nothing.

## Commands

| Command | Description |
| --------- | ------------- |
| `/zen-status` | Show fallback state: on/off, active model, models cooling down |
| `/zen-reset` | Clear exhausted-model marks and return to the default model (`deepseek-v4-flash-free`) |
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
