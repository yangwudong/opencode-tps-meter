# opencode-tps-meter

[English](./README.md) | 中文

一个 [opencode](https://opencode.ai) 的 TUI 插件，在输入框旁边实时显示 LLM 输出速度指标。

![](https://img.shields.io/npm/v/@jack-yang/opencode-tps-meter) ![](https://img.shields.io/npm/l/@jack-yang/opencode-tps-meter) ![](https://img.shields.io/github/stars/yangwudong/opencode-tps-meter) ![](https://img.shields.io/badge/opencode-1.17.20-tested-blue)

## 显示效果

空闲时：
```
TPS 42.5 | AVG 38.2 | TTFT 0.8s
```

模型推理时（TTFT 右侧出现流动的粒子条）：
```
TPS 42.5 | AVG 38.2 | TTFT 0.8s ⠒⠑⠂
```

- **TPS** — 当前每秒 token 数（实时跳动，带颜色）
- **AVG** — 整个会话的累计平均速度（消息完成后更新，带颜色）
- **TTFT** — 首个 token 的等待时间，第一个 token 到达即显示，保留到下次生成（带颜色）
- **思考粒子条** — 推理流式输出时，TTFT 右侧出现一个 FIFO 粒子流（左侧最新、向右渐暗，颜色随时间渐变）。仅在思考时渲染，空闲时不占位。

## 颜色等级

**TPS 和 AVG**（越高越好）：

| 等级 | 范围 | 颜色 |
|------|------|------|
| 慢 | < 20 TPS | 红色 |
| 正常 | 20–50 TPS | 黄色 |
| 快 | 50–100 TPS | 绿色 |
| 很快 | > 100 TPS | 青色 |

**TTFT**（越低越好）：

| 等级 | 范围 | 颜色 |
|------|------|------|
| 快 | < 10s | 绿色 |
| 一般 | 10–20s | 黄色 |
| 慢 | > 20s | 红色 |

## 安装

> **注意：** 本插件必须配置在 `tui.json` 中，**不是** `opencode.json`。

### 一条命令（推荐）

```bash
opencode plugin @jack-yang/opencode-tps-meter -g
```

安装插件并更新配置。重启 opencode 即可。（使用默认配置；如需自定义，见下方[配置](#配置)的元组形式。）

### 手动：npm

在 `~/.config/opencode/tui.json` 的 `plugin` 数组中添加 `@jack-yang/opencode-tps-meter`：

```json
{
  "plugin": [
    "@jack-yang/opencode-tps-meter"
  ]
}
```

### GitHub

```json
{
  "plugin": [
    "git+https://github.com/yangwudong/opencode-tps-meter.git"
  ]
}
```

### 本地文件

1. 下载 [`tui.tsx`](./tui.tsx) 到 opencode 配置目录：

```bash
curl -o ~/.config/opencode/tps-meter.tsx https://raw.githubusercontent.com/yangwudong/opencode-tps-meter/main/tui.tsx
```

2. 在 `~/.config/opencode/tui.json` 中引用：

```json
{
  "plugin": [
    "./tps-meter.tsx"
  ]
}
```

3. 重启 opencode。

## 配置

所有配置项都是可选的——默认值即开即用。通过 `tui.json` 的元组形式传入：

```json
{
  "plugin": [
    ["@jack-yang/opencode-tps-meter", {
      "spinner": {
        "theme": "tech",
        "colors": ["#00e5ff", "#2979ff", "#651fff"],
        "intervalMs": 100,
        "cells": 6
      },
      "tiers": {
        "tps":  { "slow": 20, "normal": 50, "fast": 100 },
        "ttft": { "fast": 10000, "ok": 20000 }
      }
    }]
  ]
}
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `spinner.theme` | `"tech"` | 配色预设：`"tech"`（青→蓝→紫）或 `"red"`（KITT 风格红）。`"none"` 关闭思考粒子流。 |
| `spinner.colors` | _随 theme_ | 自定义渐变（十六进制字符串数组）；覆盖 theme。 |
| `spinner.intervalMs` | `100` | 粒子流帧间隔（毫秒）。 |
| `spinner.cells` | `6` | 粒子流格数（宽度）。 |
| `tiers.tps` | `{20,50,100}` | TPS/AVG 阈值（慢/正常/快，单位 TPS）；超过 fast 为"很快"。 |
| `tiers.ttft` | `{10000,20000}` | TTFT 阈值（毫秒，快/正常）；超过 ok 为"慢"。 |

> 一条命令安装（`opencode plugin ...`）使用默认值；如需自定义，改用上面的元组形式。

## 工作原理

### 实时 TPS

在 5 秒滚动窗口内追踪文本/推理的 delta 事件。使用壁钟时长（`当前时间 - 最早样本时间`）而非间隔时间累加，避免网络批量传输导致的 TPS 虚高。

Token 估算使用 `ceil(字节数 / 4)`，并带有**校准因子**：消息完成时，将估算的 token 数与实际的 `tokens.output + tokens.reasoning` 对比，用中位数比率自动修正后续估算。

### AVG

所有已完成消息的会话级累计平均值：`总实际 token 数 / 总生成时长`。消息完成时更新。生成时长 = 每条消息的 `最后 delta - 首个 delta`（不含工具执行时间和 TTFT）。

### TTFT

从消息创建（`info.time.created`）到第一个文本/推理 delta 的时间。第一个 token 到达时立即显示，保留到下次生成开始。

## 开发

```bash
git clone https://github.com/yangwudong/opencode-tps-meter.git
cd opencode-tps-meter
npm install
npm test
```

纯计算函数（`measure.ts`）有 29 个单元测试。TUI 插件（`tui.tsx`）是独立的单文件（所有函数内联），可直接部署。

## 环境要求

- opencode >= 1.4.3（已在 1.17.20 测试）

## 许可证

MIT
