const fs = require("fs"), path = require("path"), vm = require("vm");
const code = fs.readFileSync(path.join(__dirname, "lib", "client.js"), "utf8");
const regs = [], injects = []; let captured = null;

const ctx = {
  slots: {
    inject(n, fn) { injects.push(n); const o = fn(); return typeof o === "function" ? o : () => {}; },
    register(opts, comp) { regs.push({ opts, comp }); return () => {}; },
  },
  get: (name) => name === "sessions"
    ? { list: { getSnapshot: () => ({ byId: { s1: { projectionValues: { tokenUsage } } } }) } }
    : { selectPanel: (id) => console.log("  [selectPanel]", id) },
};
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {}, useRef: (v) => ({ current: v === undefined ? null : v }),
  useCallback: (fn) => fn,
};
// 真实形态：扁平 buckets（来自 probe 实测数据）
const tokenUsage = { uncachedInputTokens: 13902, outputTokens: 33520, cacheReadTokens: 815616, cacheWriteTokens: 0 };
const snapshot = { byId: { s1: { projectionValues: { tokenUsage } } } };
const useSessionsStub = (sel) => sel(snapshot);

const mem = new Map([["dsh.balance.key", "sk-test"]]);
const sandbox = {
  console,
  window: { __ModuleLoader__: { load(e) { captured = e; } }, open: () => {} },
  document: { cookie: "", head: null, getElementById: () => null, createElement: () => ({}) },
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ total_balance: "73.62", granted_balance: "0", topped_up_balance: "73.62", currency: "CNY" }] }) }),
  require: (id) => { if (id === "react") return React; throw new Error("unexpected require " + id); },
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  Date, Math, JSON, Number, Array, Object, String, Promise, Symbol,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });

const mod = captured.factory(sandbox.require);
mod.apply(ctx);
console.log("seats:", injects.join(" -> "));
for (const r of regs) console.log("  ", JSON.stringify(r.opts));

const T = mod.__test;
console.log("\nreadUsage(s1):", JSON.stringify(T.readUsage("s1")));
console.log("会话花费:", T.costOf(T.readUsage("s1")).toFixed(4), "token:", T.tokenTotal(T.readUsage("s1")));

const props = { sessionId: "s1" };
for (const r of regs) {
  const p = r.opts.name === "main" || r.opts.name === "sidebar.panellist" ? {} : props;
  try {
    const tree = r.comp(p);
    const label = tree ? tree.type : "null";
    const text = (function collect(n) {
      if (n === null || n === undefined || n === false) return "";
      if (typeof n === "string" || typeof n === "number") return String(n);
      if (Array.isArray(n)) return n.map(collect).join("");
      return collect(n.children);
    })(tree);
    console.log("render", r.comp.name, "->", label, text ? "| " + text : "");
  } catch (e) { console.log("render FAIL", r.comp.name, e.message); process.exitCode = 1; }
}