// HUD 插件的无头测试台：用 jsdom 模拟 DSH 的 DOM 与 sessionStatus
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import fs from "node:fs";
import React from "react";
import { createRoot } from "react-dom/client";

const PLUGIN = process.argv[2] || "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-plugin-hud/lib/client.js";
const require = createRequire(import.meta.url);

const SID = "session-aaa-bbb";
const SID2 = "session-ccc-ddd";

const html = `<!doctype html><html><body>
  <div id="app">
    <div class="sidebar">
      <div data-row-key="session:${SID}" role="treeitem" aria-selected="true"><span class="title">会话 A</span></div>
      <div data-row-key="session:${SID2}" role="treeitem"><span class="title">会话 B</span></div>
    </div>
    <div data-slot="conversation.session.header">会话 A</div>
    <textarea data-slot="composer-input"></textarea>
    <div data-slot="conversation.composer"><button aria-label="send">↑</button></div>
  </div>
</body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom;
const { document } = window;

const RECT = { left: 0, top: 100, width: 240, height: 34, right: 240, bottom: 134, x: 0, y: 100 };
window.Element.prototype.getBoundingClientRect = function () { return { ...RECT, toJSON() { return RECT; } }; };

globalThis.window = window;
globalThis.document = document;
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.matchMedia = globalThis.matchMedia;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = window.ResizeObserver;
window.HTMLCanvasElement.prototype.getContext = () => null;
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

globalThis.fetch = () => Promise.reject(new Error("harness-no-probe"));
window.fetch = globalThis.fetch;
window.Image = class { set src(_v) {} };

let mod = null;
window.__ModuleLoader__ = {
  load({ factory }) {
    mod = factory((name) => (name === "react" ? React : require(name)));
  },
};

const code = fs.readFileSync(PLUGIN, "utf8");
new Function("window", "document", "React", "localStorage", code)(window, document, React, window.localStorage);
if (!mod) throw new Error("插件没有调用 __ModuleLoader__.load");

const seats = new Map();
let tickErrors = 0;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => realSetInterval(() => {
  try { fn(); } catch (e) {
    if (tickErrors++ < 3) console.log("  ⚠ tick 异常:", e && e.message);
  }
}, ms, ...rest);
window.setInterval = globalThis.setInterval;

const ctx = {
  effect(fn) { fn(); },
  timeout(fn, ms) { return setTimeout(fn, ms); },
  get() { return undefined; },
  slots: {
    inject(name, fn) { fn(); },
    register(meta, Component) { seats.set(meta.name, { meta, Component }); return { dispose() {} }; },
  },
};

mod.apply(ctx);
console.log("已注册座位:", [...seats.keys()].join(", "));

const statusMap = new Map();
const useSessionStatus = (sel) => (typeof sel === "function" ? sel(statusMap) : statusMap);
const useSessions = () => ({ list: { getSnapshot: () => ({ byId: {} }) } });

function mountSeat(name) {
  const seat = seats.get(name);
  if (!seat) return;
  const el = document.createElement("div");
  document.body.appendChild(el);
  createRoot(el).render(React.createElement(seat.Component, {
    useSessionStatus, useSessions, sessionId: SID, t: (s) => s,
  }));
}
mountSeat("sidebar.session.row.leading");
mountSeat("main");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const layer = () => document.getElementById("dsh-hud-rowfx");
const sel = (cls) => [...(layer()?.querySelectorAll(cls + "[data-sid]") || [])];
const rings = () => sel(".hud-fx-ring");
const rings2 = () => sel(".hud-fx-ring2");
const bars = () => sel(".hud-fx-bar");
const heads = () => sel(".hud-fx-head");

const run = (sid, running) => statusMap.set(sid, { running, pendingInteraction: undefined, completionUnread: !running });

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✅", name); }
  else { fail++; console.log("  ❌", name, extra); }
}
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120); }
  return false;
}

await sleep(500);

console.log("\n[1] 初始状态");
check("初始没有动态元素", (layer()?.querySelectorAll("[data-sid]").length || 0) === 0);

console.log("\n[2] 会话 A 开始运行");
run(SID, true);
check("环出现", await waitFor(() => rings().length >= 1, 4000), `count=${rings().length}`);
check("环可见", rings().some((r) => r.style.opacity === "1"));
check("双环：反向环也可见", rings2().length >= 1 && rings2().some((r) => parseFloat(r.style.opacity) > 0));

console.log("\n[3] 5 秒后切换为进度条");
check("条出现并可见", await waitFor(() => bars().some((b) => b.style.opacity === "1"), 9000), "timeout");
await sleep(300);
const widths = bars().map((b) => parseFloat(b.style.width) || 0);
check("条宽度在合理区间", widths.every((w) => w > 0 && w <= 240), JSON.stringify(widths));
check("切到输出时触发该行的扫光", !!layer()?.querySelector(".hud-fx-rowsweep"));
check("活跃行有呼吸光", sel(".hud-fx-glow").some((g) => g.style.opacity === "1"));

console.log("\n[4] 会话 B 同时运行");
run(SID2, true);
check("出现两套环/条", await waitFor(() => rings().length + bars().length >= 4, 4000), `rings=${rings().length} bars=${bars().length}`);

console.log("\n[5] 会话 A 结束");
run(SID, false);
check("A 的条补满", await waitFor(() => bars().some((b) => (parseFloat(b.style.width) || 0) >= 239), 4000));
check("完成时带 data-done（触发白光扫）", bars().some((b) => b.dataset.done === "1"));
check("A 的元素被清理", await waitFor(() => {
  return [...(layer()?.querySelectorAll("[data-sid]") || [])].filter((e) => e.dataset.sid.endsWith("aaa-bbb")).length === 0;
}, 8000));

console.log("\n[6] 会话 B 结束");
run(SID2, false);
check("全部清理", await waitFor(() => (layer()?.querySelectorAll("[data-sid]").length || 0) === 0, 8000));

console.log("\n[7] 兜底路径：回车启动 → 消息尾结束");
document.querySelector("textarea").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
check("回车后出现环", await waitFor(() => rings().length >= 1, 4000));
check("回车触发发送冲击波", !!layer()?.querySelector(".hud-fx-shock"));
check("5 秒后切到条", await waitFor(() => bars().some((b) => b.style.opacity === "1"), 9000));
const tail = document.createElement("div");
tail.setAttribute("data-slot", "conversation.chat.turnTail");
document.body.appendChild(tail);
check("消息尾出现后补满", await waitFor(() => bars().some((b) => (parseFloat(b.style.width) || 0) >= 239), 5000));
check("补满后清理", await waitFor(() => (layer()?.querySelectorAll("[data-sid]").length || 0) === 0, 8000));
const _b = layer()?.querySelector(".hud-fx-bar"); const _r = layer()?.querySelector(".hud-fx-ring"); console.log("   状态: 元素=" + (layer()?.querySelectorAll("[data-sid]").length || 0) + " bar.op=" + (_b ? _b.style.opacity : "-") + " bar.w=" + (_b ? _b.style.width : "-") + " ring.op=" + (_r ? _r.style.opacity : "-"));

console.log(`\n结果: ${pass} 通过, ${fail} 失败${tickErrors ? `（tick 异常 ${tickErrors} 次）` : ""}`);
process.exit(fail || tickErrors ? 1 : 0);
