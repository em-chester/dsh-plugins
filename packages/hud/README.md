# dsh-plugin-hud

科幻风格背景与状态光效。用**会话状态**驱动整屏配色与动效：思考紫、输出橙、打字青、告警红。

完整安装与使用说明见[仓库根 README](../../README.md)。

## 五种状态

| 状态 | 触发 | 色相 | 视觉 |
| --- | --- | --- | --- |
| 空闲 | 2.6 秒无活动 | 灰蓝 `212` | 背景极淡，数据流最慢 |
| 打字 | 1.6 秒内有输入 | 青蓝 `188` | 输入框背后涟漪 + 边框泛光 |
| 思考 | 请求中、本轮未吐字 | 紫罗兰 `262` | 会话行**边框**光弧绕行 |
| 输出 | 聊天区 DOM 有增长 | 橙红 `26` | 会话行**恒长光带**左→右扫 |
| 告警 | 余额 < 阈值 | 红 `355` | 整屏暗角脉动 |

## 判定方式（不依赖官方状态 API）

```js
// 输出：监听聊天区的 DOM 变化
new MutationObserver(() => (lastFlowAt = Date.now()))
  .observe(document.querySelector("[data-chat-flow]"), { childList: true, subtree: true, characterData: true });

// 思考：[data-phase="active"] 且本轮还没吐过字（sawStream 标记）
// 收尾：出现 [data-slot*="turnTail"] 或文本含「已完成 / 用时」
```

## 座位

| 座位 | 作用 |
| --- | --- |
| `sidebar.session.row.leading` | 会话行光效（`::after`，与余额插件的 `::before` 不冲突） |
| `sidebar.panellist` | 侧栏「HUD」入口 |
| `main` | 设置面板 + 预览 |

## 设置面板

强度滑杆、六个分层开关、告警阈值，以及**预览区**——强制播放任意状态 6 秒，调参不用真发消息。

## 开发

```powershell
node --check lib/client.js
node test-apply.cjs
```

改完 `client.js` 后 HMR 自动生效；但 `<style>` 必须复用同一标签并重写 `textContent`，否则样式更新不生效。
