const fs = require("fs"), path = require("path"), vm = require("vm");

const code = fs.readFileSync(path.join(__dirname, "lib", "client.js"), "utf8");
const regs = [], injects = []; let captured = null;

const ctx = {
  slots: {
    inject(n, fn) { injects.push(n); const o = fn(); return typeof o === "function" ? o : () => {}; },
    register(opts, comp) { regs.push({ opts, comp }); return () => {}; },
  },
  get: (name) => name === "sessions"
    ? { list: { getSnapshot: () => ({ byId: {
        s1: { projectionValues: { tokenUsage: { uncachedInputTokens: 1200, outputTokens: 3400, cacheReadTokens: 90000, cacheWriteTokens: 0 } } },
      } }) } }
    : undefined,
};

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v === undefined ? null : v }),
  useCallback: (fn) => fn,
};

const el = () => ({
  style: { cssText: "", setProperty() {}, removeProperty() {} },
  setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
  appendChild() {}, insertBefore() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  classList: { add() {}, remove() {}, toggle() {} },
  getBoundingClientRect: () => ({ width: 800, height: 120, top: 0, left: 0, right: 800, bottom: 120 }),
  closest() { return null; }, remove() {}, matches() { return false; },
});
const mem = new Map();
const sandbox = {
  console,
  window: {
    __ModuleLoader__: { load(e) { captured = e; } },
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 820, devicePixelRatio: 1,
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
  },
  document: {
    cookie: "", head: el(), body: Object.assign(el(), { firstChild: null }),
    documentElement: el(),
    getElementById: () => null, createElement: () => el(),
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
  },
  localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
  require: (id) => { if (id === "react") return React; throw new Error("unexpected require " + id); },
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  Date, Math, JSON, Number, Array, Object, String, Promise, Symbol, Map, Set,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "client.js" });

const mod = captured.factory(sandbox.require);
mod.apply(ctx);
console.log("seats:", injects.join(" -> "));
for (const r of regs) console.log("  ", JSON.stringify(r.opts));

for (const r of regs) {
  try {
    const tree = r.comp({ sessionId: "s1" });
    console.log("render", r.comp.name, "->", tree ? tree.type : "null");
  } catch (e) { console.log("render FAIL", r.comp.name, e.message); process.exitCode = 1; }
}

const T = mod.__test;
console.log("\nHUE:", JSON.stringify(T.HUE));
console.log("buckets:", JSON.stringify(T.bucketsOf({ tokenUsage: { uncachedInputTokens: 1, outputTokens: 2 } })));
console.log("注册数:", regs.length);
const need = ["sidebar.session.row.leading", "sidebar.panellist", "main"];
const ok = need.every((n) => injects.includes(n));
console.log("座位齐全:", ok);
if (!ok) process.exitCode = 1;
