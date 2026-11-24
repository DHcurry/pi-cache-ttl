import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * cache-ttl — footer indicator for provider prompt-cache state.
 *
 * Layered TTL resolution (first match wins):
 *   1. /cache-ttl <dur>        session override (clear with /cache-ttl auto)
 *   2. PI_CACHE_TTL_SECONDS    env override (explicit operator intent wins)
 *   3. ctx.model.promptCache   Pi's official per-model declaration (models.json)
 *   4. per-provider table      measured / documented values below
 *   5. unknown                 show idle age only — no fake countdown
 *
 * Display modes:
 *   fixed   : countdown to expiry (green / yellow <5min / red expired)
 *   lru     : idle age, no fixed expiry (green <30min / yellow <2h / red >=2h)
 *   unknown : idle age in gray, TTL not published — no false precision
 *
 * Usage:
 *   /cache-ttl          show status + where the TTL came from
 *   /cache-ttl 90m      session override (90 | 90s | 90m | 2h)
 *   /cache-ttl auto     clear session override
 *   PI_CACHE_TTL_SECONDS=5400 pi   env override
 */

const STATUS_KEY = "cache-ttl";
const WARN_SECONDS = 300; // fixed mode: yellow when < 5 minutes remain
const LRU_WARN_SECONDS = 30 * 60; // lru mode: yellow after 30 min idle
const LRU_DANGER_SECONDS = 2 * 60 * 60; // lru mode: red after 2 h idle
const TICK_MS = 1000;

type Profile =
  | { kind: "fixed"; seconds: number; source: string }
  | { kind: "lru"; source: string }
  | { kind: "unknown"; source: string };

/**
 * Measured from this machine's own session data (2026-10/11) or from
 * vendor documentation. Providers not listed resolve to "unknown".
 */
const PROVIDERS: Record<string, Profile> = {
  xiaomi: { kind: "fixed", seconds: 7200, source: "实测:90min命中/123min失效" },
  deepseek: { kind: "lru", source: "LRU逐出+命中刷新(实测14.8h仍命中)" },
  anthropic: { kind: "fixed", seconds: 300, source: "官方:short 5min / long 1h" },
  openai: { kind: "fixed", seconds: 600, source: "业界~10min(未官宣)" },
  siliconflow: { kind: "unknown", source: "官方未公布缓存机制/TTL" },
  relay: { kind: "unknown", source: "中转:取决于上游+路由粘滞" },
  "llamacpp-local": { kind: "lru", source: "本地内存LRU" },
  "llama.cpp": { kind: "lru", source: "本地内存LRU" },
  ollama: { kind: "lru", source: "本地内存LRU" },
};

interface Resolved {
  kind: "fixed" | "lru" | "unknown";
  seconds: number; // only meaningful for "fixed"
  source: string;
}

function resolve(ctx: ExtensionContext | undefined, sessionOverride: number | undefined): Resolved {
  // 1. session override — most immediate explicit intent
  if (sessionOverride && sessionOverride > 0) {
    return { kind: "fixed", seconds: sessionOverride, source: "session /cache-ttl" };
  }
  // 2. env override — explicit operator intent beats config files
  const env = Number(process.env.PI_CACHE_TTL_SECONDS);
  if (Number.isFinite(env) && env > 0) {
    return { kind: "fixed", seconds: Math.floor(env), source: "env PI_CACHE_TTL_SECONDS" };
  }
  // 3. model's own promptCache declaration (Pi official mechanism)
  const model = ctx?.model as
    | { provider?: string; promptCache?: { short?: number; long?: number } }
    | undefined;
  const tier = (process.env.PI_CACHE_RETENTION ?? "").toLowerCase() === "long" ? "long" : "short";
  const declared = model?.promptCache?.[tier] ?? model?.promptCache?.short ?? model?.promptCache?.long;
  if (typeof declared === "number" && declared > 0) {
    return { kind: "fixed", seconds: Math.round(declared), source: `model.promptCache(${tier})` };
  }
  // 4. per-provider measured/documented table
  const provider = model?.provider;
  if (provider && provider in PROVIDERS) {
    const p = PROVIDERS[provider];
    return p.kind === "fixed"
      ? { kind: "fixed", seconds: p.seconds, source: p.source }
      : { kind: p.kind, seconds: 0, source: p.source };
  }
  // 5. unknown — show idle age, don't invent an expiry
  return { kind: "unknown", seconds: 0, source: provider ? `未收录provider(${provider})` : "无模型" };
}

/** Format seconds as m:ss, or h:mm:ss when >= 1 hour. */
function formatSpan(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Parse "90", "90s", "90m", "1.5h" into seconds. Returns undefined on garbage. */
function parseDuration(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = Math.round(n * mult);
  return seconds > 0 ? seconds : undefined;
}

export default function cacheTtlExtension(pi: ExtensionAPI) {
  /** Session-level override from /cache-ttl <dur>; undefined = follow layered resolution. */
  let sessionOverride: number | undefined;
  /** ms epoch of the last provider request — that request refreshed the cache. */
  let lastActiveAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let mountedCtx: ExtensionContext | undefined;

  const render = () => {
    const ctx = mountedCtx;
    if (!ctx?.hasUI) return;
    if (!lastActiveAt) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const profile = resolve(ctx, sessionOverride);
    const idleMs = Date.now() - lastActiveAt;
    const age = formatSpan(idleMs / 1000);
    let text: string;

    if (profile.kind === "fixed") {
      const remainingMs = profile.seconds * 1000 - idleMs;
      if (remainingMs > 0) {
        const tone = remainingMs <= WARN_SECONDS * 1000 ? "warning" : "success";
        text = ctx.ui.theme.fg(tone, `⏳ cache ${formatSpan(remainingMs / 1000)}`);
      } else {
        text = ctx.ui.theme.fg("error", `✕ cache expired ${formatSpan(-remainingMs / 1000)}`);
      }
    } else if (profile.kind === "lru") {
      // No fixed expiry — show idle age; longer untouched = higher eviction risk.
      const tone =
        idleMs < LRU_WARN_SECONDS * 1000
          ? "success"
          : idleMs < LRU_DANGER_SECONDS * 1000
            ? "warning"
            : "error";
      text = ctx.ui.theme.fg(tone, `⏳ LRU idle ${age}`);
    } else {
      // TTL not published — idle age only, no false countdown.
      text = ctx.ui.theme.fg("muted", `⏳ idle ${age} ·TTL?`);
    }
    ctx.ui.setStatus(STATUS_KEY, text);
  };

  const ensureTimer = () => {
    if (!timer) timer = setInterval(render, TICK_MS);
  };

  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  /** Seed lastActiveAt from the session's most recent real assistant request. */
  const seedFromSession = (ctx: ExtensionContext) => {
    try {
      const entries = ctx.sessionManager.getEntries() as Array<{
        type?: string;
        timestamp?: string;
        message?: { role?: string; usage?: { input?: number; cacheRead?: number } };
      }>;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
        const usage = entry.message.usage;
        if (!usage || (usage.input <= 0 && usage.cacheRead <= 0)) continue;
        const t = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
        if (Number.isFinite(t)) lastActiveAt = t;
        return;
      }
    } catch {
      // Unreadable session — start cold, the first request will arm the countdown.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    mountedCtx = ctx;
    sessionOverride = undefined;
    seedFromSession(ctx);
    render();
    ensureTimer();
  });

  pi.on("session_shutdown", async () => {
    stopTimer();
    if (mountedCtx?.hasUI) mountedCtx.ui.setStatus(STATUS_KEY, undefined);
    mountedCtx = undefined;
    lastActiveAt = 0;
    sessionOverride = undefined;
  });

  // Every provider request refreshes the implicit prefix cache.
  pi.on("before_provider_request", async () => {
    lastActiveAt = Date.now();
    render();
  });

  // Profile depends on the active model — re-render immediately on switch.
  pi.on("model_select", async () => {
    render();
  });

  pi.registerCommand("cache-ttl", {
    description: "Show prompt-cache state; set TTL with /cache-ttl 90m, reset with /cache-ttl auto",
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = (args ?? "").trim();
      if (arg) {
        if (arg.toLowerCase() === "auto" || arg.toLowerCase() === "reset") {
          sessionOverride = undefined;
          render();
          if (ctx.hasUI) ctx.ui.notify("cache TTL override cleared (back to layered resolution)", "info");
          return;
        }
        const parsed = parseDuration(arg);
        if (parsed !== undefined) {
          sessionOverride = parsed;
          render();
          if (ctx.hasUI) ctx.ui.notify(`cache TTL override: ${formatSpan(sessionOverride)}`, "info");
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Usage: /cache-ttl [90 | 90s | 90m | 2h | auto]", "error");
        return;
      }
      if (!ctx.hasUI) return;
      const profile = resolve(ctx, sessionOverride);
      const mode =
        profile.kind === "fixed"
          ? `TTL ${formatSpan(profile.seconds)}`
          : profile.kind === "lru"
            ? "LRU(无固定过期)"
            : "TTL未知";
      if (!lastActiveAt) {
        ctx.ui.notify(`[${profile.source}] ${mode} · 本 session 尚无请求`, "info");
        return;
      }
      const age = formatSpan((Date.now() - lastActiveAt) / 1000);
      ctx.ui.notify(`[${profile.source}] ${mode} · 上次请求 ${age} 前`, "info");
    },
  });
}
