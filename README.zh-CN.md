# opencode-tps-meter

[English](./README.md) | 中文

一个 [opencode](https://opencode.ai) 的 TUI 插件，在输入框旁边实时显示 LLM 输出速度指标。

![](https://img.shields.io/npm/v/@jack-yang/opencode-tps-meter) ![](https://img.shields.io/npm/l/@jack-yang/opencode-tps-meter) ![](https://img.shields.io/github/stars/yangwudong/opencode-tps-meter)

## 显示效果

```
TPS 42.5 | AVG 38.2 | TTFT 0.8s
```

- **TPS** — 当前每秒 token 数（实时跳动，带颜色）
- **AVG** — 整个会话的累计平均速度（消息完成后更新，带颜色）
- **TTFT** — 首个 token 的等待时间，第一个 token 到达即显示，保留到下次生成（带颜色）

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
| 快 | < 0.5s | 绿色 |
| 一般 | 0.5–2s | 黄色 |
| 慢 | > 2s | 红色 |

## 安装

> **注意：** 本插件必须配置在 `tui.json` 中，**不是** `opencode.json`。

### 方式一：npm 安装（推荐）

在 `tui.json` 的 `plugin` 数组中添加 `@jack-yang/opencode-tps-meter`：

```json
{
  "plugin": [
    "@jack-yang/opencode-tps-meter"
  ]
}
```

配置文件位置：`~/.config/opencode/tui.json`

重启 opencode 即可。

### 方式二：从 GitHub 安装

```json
{
  "plugin": [
    "git+https://github.com/yangwudong/opencode-tps-meter.git"
  ]
}
```

### 方式三：本地文件

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

- opencode >= 1.4.3

## 许可证

MIT
