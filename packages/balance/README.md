# dsh-plugin-balance

给 DeepSeek Harness 的 Web 客户端加一个**侧栏「余额」入口**，点开是一整块主面板：

- 当前余额 + 水位条（>¥50 绿 / ¥10–50 琥珀 / <¥10 红）
- 赠送 / 充值拆分、更新时间
- 今日 / 本月消耗（本地采样）
- 去充值按钮、换 Key

## 形态

```
侧栏                    主面板
─────────────────────  ──────────────────────────────
🆕 新会话              DeepSeek 余额           [刷新] [换 Key]
📁 工作区              ¥ 73.62
🧩 插件                赠送 ¥0.00 · 充值 ¥73.62
💰 余额  ← 新增        ▓▓▓▓▓▓▓▓▓▓▓░░░░░  74%
                       今日 ¥1.13   本月 ¥45.67   可用
                       [去充值]
```

## 实现要点

| 项 | 说明 |
| --- | --- |
| 侧栏入口 | `ctx.slots.register({ name: "sidebar.panellist", id: "balance", order: 30, label })` |
| 主面板 | `ctx.slots.register({ name: "main", key: "balance" }, Panel)`（`main` 是 root 作用域的 keyed slot） |
| 数据来源 | 客户端直接 `fetch https://api.deepseek.com/user/balance` —— 该接口回显 Origin 并允许凭据，所以**不需要主机路由** |
| Key 存储 | localStorage + cookie 双写（端口每次启动会变，cookie 按 host 存才不会丢） |
| 消耗统计 | 每次成功查询往本地历史里采样，相邻采样的**下降**计为消耗，充值（上升）不计 |

主机半边（`lib/index.js`）是空实现，纯粹为了让 loader 条目合法。

## 安装

已安装到 `~/.dsh/profiles/desktop`：

```
profiles/desktop/
├─ plugins/dsh-plugin-balance/          ← 插件本体
├─ node_modules/dsh-plugin-balance      ← junction 指向上面的目录
├─ package.json                         ← dependencies + dsh.profile.bundles 各加一条
└─ cordis.patch.yml                     ← 不需要改（bundle 自带 patch）
```

`package.json` 里：

```json
"dependencies": { "dsh-plugin-balance": "file:./plugins/dsh-plugin-balance" },
"dsh": { "profile": { "bundles": [ ..., "dsh-plugin-balance" ] } }
```

插件自带 `cordis.patch.yml`，由 bundle 层插入：

```yaml
- insert:
    - id: dsh-plugin-balance
      name: dsh-plugin-balance
```

## 卸载 / 回滚

```bat
:: 1) 从 bundles 里摘掉并删目录
::    （或直接用备份还原）
copy "%USERPROFILE%\.dsh\profiles\desktop\package.json.bak-*" "%USERPROFILE%\.dsh\profiles\desktop\package.json"
rmdir /s /q "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-balance"
rmdir /s /q "%USERPROFILE%\.dsh\profiles\desktop\plugins\dsh-plugin-balance"
```

## 开发

```bat
:: 语法检查
node --check lib/client.js
:: 桩环境跑注册逻辑（不需要 DSH）
node test-apply.cjs
```

改完 `lib/*.js` 后复制到 profile 的 `plugins/dsh-plugin-balance/`，刷新页面即可（HMR 已开启；
若侧栏没出现，重启一次 DSH）。

## 三个座位（v0.2）

| 座位 | 用途 |
| --- | --- |
| `conversation.session.header.actions` | **聊天头部的小胶囊**：`● ¥73.62`，不用切面板就能看到；点它跳到余额面板 |
| `sidebar.panellist` | 侧栏「余额」入口 |
| `main` | 完整面板（水位、今日/本月、去充值） |

没配 Key 时胶囊不渲染（不占位）；请求失败时显示 `Key 无效` / `余额 ?` + 悬停看原因。
三个座位共享同一个 60 秒轮询 store，只发一份请求。

## v0.3：会话花费 + 本轮消耗 + 动效

新增两个座位：

| 座位 | 显示 |
| --- | --- |
| `sidebar.session.row.leading` | 每个会话后面的估算花费（`¥5.42`），悬停看 token 数 |
| `conversation.input.dock` | 输入框上方一行：`本轮 ¥0.051`｜`今日 ¥1.13`｜`余额 ¥73.62` |

数据来自 session 投影 `projectionValues.tokenUsage`：
`totals`（累计）/ `last.buckets`（上一轮）。座位渲染器会注入 `sessionId` 和 `useSessions`。

计价规则（面板里可改，默认 ¥2/¥8 每百万 token）：

```
cost = (uncachedInput + cacheWrite + cacheRead × 0.25) × 输入单价
     + output × 输出单价            ÷ 1M
```

缓存命中按 1/4 计，与官方缓存价一致。**这是估算**，不是账单。

动效（纯 CSS + rAF，不引依赖）：

- 数字滚动：余额变化时 73.20 → 73.62 过渡
- 迷你水位：胶囊内的横向填充条，宽度 = 余额/100
- 低余额呼吸：<¥10 时状态点做 1.6s 明暗循环
- 刷新转圈：请求中 ⟳ 旋转
- 变化闪烁：余额下降时胶囊背景/描边闪一下