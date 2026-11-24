# Changelog

## [1.0.0] - 2026-11-24

Initial release.

- Footer countdown for provider prompt-cache expiry: green / yellow (<5 min) / red (expired), refreshed every second and reset on every provider request.
- Layered TTL resolution (first match wins): session override (`/cache-ttl 90m`) → `PI_CACHE_TTL_SECONDS` env → model `promptCache` declaration → per-provider measured table → unknown.
- Three display modes matching real cache mechanisms: `fixed` countdown, `LRU idle` age (deepseek / local models, no fixed expiry), and gray `idle ·TTL?` when the provider does not publish a TTL.
- Built-in provider table with measured/documented values (xiaomi ≈2h measured, anthropic 5min/1h, openai ~10min estimate, deepseek LRU, siliconflow/relay unknown).
- Resume-aware: seeds the countdown from the last assistant message in the session file.
- Re-resolves the profile on `/model` switches.
- `/cache-ttl` command: show status and TTL source, set a session override (`90 | 90s | 90m | 2h`), clear it with `auto`.
- Zero cost: no network requests, no LLM calls; reads local session state only.
