# pi-cache-ttl

> Pi 扩展：在 TUI footer 实时倒计时显示 **prompt cache 剩余热度**。
>
> A Pi extension that shows a live prompt-cache TTL countdown in your footer, so you always know how long the provider's prefix cache will stay warm.

```
⏳ cache 12:34        ← 绿色：缓存充足
⏳ cache 0:47         ← 黄色：剩余不足 5 分钟
✕ cache expired 3:12  ← 红色：已过期，下一条消息将是 cache miss
⏳ LRU idle 45:12     ← 按 provider 为 LRU 机制时：只显示闲置时长（无固定过期）
⏳ idle 12:34 ·TTL?   ← provider 未公布 TTL 时：只报事实，不编造倒计时
```

## 为什么需要它

LLM provider 的前缀缓存（prompt cache）会在闲置一段时间后过期，过期后你的**整个上下文**会按全价 input 重新计费——一个 30 万 token 的会话一次 miss 就是几美分甚至更多。这个扩展把"缓存还热不热"变成 footer 里一眼可见的倒计时，让你知道：

- 现在发消息能不能命中缓存
- 闲置多久之前必须回来续上
- 什么时候已经过期、下一条会 miss

## 功能

- **实时倒计时**：footer 常驻，每秒刷新，请求发出瞬间重置
- **三态配色**：绿色充足 / 黄色告警（<5 分钟）/ 红色已过期
- **分层 TTL 解析**（first match wins）：

  | 优先级 | 来源 | 说明 |
  |---|---|---|
  | 1 | `/cache-ttl 90m` | 会话级手动覆盖 |
  | 2 | `PI_CACHE_TTL_SECONDS` 环境变量 | 全局强制覆盖 |
  | 3 | `model.promptCache` | Pi 官方 per-model 声明（models.json） |
  | 4 | provider 实测/文档表 | xiaomi≈2h（实测）、deepseek=LRU、openai≈10min… |
  | 5 | unknown | 不编造倒计时，只显示闲置时长 `TTL?` |

- **按机制区分显示**：
  - **fixed TTL**（xiaomi / anthropic / openai…）→ 倒计时 + 过期红字
  - **LRU**（deepseek / 本地 llama.cpp、ollama）→ 无固定过期，显示 `LRU idle` 闲置时长，按闲置久近变色
  - **unknown**（官方未公布，如部分中转/SiliconFlow）→ 灰色 `idle ·TTL?`，只报事实
- **断点续传**：恢复旧 session 时从文件里最后一条 assistant 消息接上倒计时
- **模型切换感知**：`/model` 切换后立即按新模型的 TTL 重新解析
- **零成本**：只读 session 状态、只写 footer 一行，不发任何网络请求、不进 LLM 上下文

## 安装

```bash
pi install npm:pi-cache-ttl
```

然后重启 pi 或在会话里 `/reload`。

本地安装 / 试用：

```bash
pi install ./pi-cache-ttl          # 本地安装
pi -e ./pi-cache-ttl               # 仅本次启动试用，不写入配置
```

## 使用

安装后自动生效，无需配置。footer 会常驻显示倒计时。

```bash
/cache-ttl              # 查看状态：TTL 来源、剩余时间、上次请求距今多久
/cache-ttl 90m          # 本会话手动指定 TTL（90 | 90s | 90m | 2h）
/cache-ttl auto         # 清除手动覆盖，回到分层解析
```

### 自定义 TTL

**方式一：环境变量（全局）**

```bash
PI_CACHE_TTL_SECONDS=5400 pi
```

**方式二：模型声明（推荐，per-model，走 Pi 官方机制）**

编辑 `~/.pi/agent/models.json`：

```json
{
  "providers": {
    "xiaomi": {
      "modelOverrides": {
        "mimo-v2.6-flash": {
          "promptCache": { "short": 7200 }
        }
      }
    }
  }
}
```

**方式三：扩展内置 provider 表**

内置了实测/文档值，开箱即用：

| provider | 机制 | TTL | 依据 |
|---|---|---|---|
| xiaomi (MiMo) | fixed | 7200s (2h) | 实测：90min 命中 / 123min 失效 |
| anthropic | fixed | 300s / 3600s | 官方 short/long 档（通常由 promptCache 声明提供） |
| openai | fixed | ~600s | 业界理解，未官宣 |
| deepseek | LRU | 无固定过期 | 实测 14.8h 仍命中，靠 LRU 逐出 |
| llamacpp-local / ollama | LRU | 无固定过期 | 本地内存缓存 |
| siliconflow / relay（中转） | unknown | 未公布 | 只显示闲置时长 |

新增 provider 默认落入 `unknown`——宁可显示 `TTL?` 也不给出错误的倒计时。

## 已知边界

- **倒计时 ≠ 命中保证**：provider 可能因 LRU/负载提前驱逐缓存（如 MiMo 的 hosted API 就有过命中率波动的报告），过期前也可能 miss。
- **图片消息**、compaction、context 改写会破坏前缀，与 TTL 无关——这类 miss 倒计时无法预警。
- 倒计时锚点是"最近一次 provider 请求发出时刻"，不是响应完成时刻。

## FAQ

**Q: 和 `timestamp-pi` 有什么区别？**
`timestamp-pi` 的倒计时硬编码 5 分钟（Anthropic 默认），对 TTL 为 2 小时的 provider 完全不准。本扩展按 provider/模型分层解析 TTL，且支持 LRU / unknown 两种非固定机制的正确显示。

**Q: 会发请求吗？会花钱吗？**
不会。纯本地读取 session 文件状态并渲染 footer，零网络、零 LLM 调用。

**Q: 中转平台（relay）能用吗？**
能显示，但中转的缓存取决于**上游**和**路由粘滞**（多 key 轮询会打散缓存），TTL 通常归入 `unknown` 显示 `TTL?`。建议先实测该中转的真实 TTL 再用 `/cache-ttl <dur>` 指定。

## License

MIT
