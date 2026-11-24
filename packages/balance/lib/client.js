/**
 * dsh-plugin-balance — browser half.
 *
 * Seats:
 *   conversation.session.header.actions  余额胶囊（数字滚动 / 迷你水位 / 低余额呼吸 / 变化闪烁）
 *   sidebar.session.row.leading          每个会话的花费
 *   sidebar.panellist                    侧栏入口
 *   main                                完整面板
 *
 * 余额走 DeepSeek 接口（该接口回显 Origin，浏览器可直连）；会话花费来自
 * session 投影 projectionValues.tokenUsage（totals 累计 / last 上一轮）。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const ID = "balance";
		const LS_KEY = "dsh.balance.key";
		const LS_HIST = "dsh.balance.history";
		const LS_RATES = "dsh.balance.rates";
		const ENDPOINT = "https://api.deepseek.com/user/balance";
		const TOPUP = "https://platform.deepseek.com/top_up";
		const POLL_MS = 60000;
		const DEFAULT_RATES = { input: 2, output: 8 }; // ¥ / 1M tokens

		// ── 官方价目表（元 / 百万 tokens，空闲时段） ────────────────
		// 来源：DeepSeek 官方计费页。高峰时段（周一至周五 9:00–12:00、14:00–18:00，北京时间）
		// 全部单价 ×2。缓存命中价只有未命中的 2%。
		const PRICES = {
			flash: { hit: 0.02, miss: 1, out: 4 },
			pro: { hit: 0.15, miss: 4.5, out: 13.5 },
		};

		function isPeak(at) {
			const d = new Date(at);
			const day = d.getDay();          // 0=周日
			if (day === 0 || day === 6) return false;
			const h = d.getHours();
			return (h >= 9 && h < 12) || (h >= 14 && h < 18);
		}

		function modelOf(projectionValues) {
			const m = projectionValues ? projectionValues.modelSelection : undefined;
			const text = typeof m === "string" ? m : (m && (m.model || m.name || m.id)) || "";
			return /pro/i.test(String(text)) ? "pro" : "flash";
		}
		// ── Key 存储：localStorage + cookie ─────────────────────────
		const COOKIE = "dsh_balance_key";
		function readCookie() {
			try {
				const hit = document.cookie.split("; ").find((x) => x.indexOf(COOKIE + "=") === 0);
				return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : "";
			} catch { return ""; }
		}
		function writeCookie(value) {
			try {
				document.cookie = value
					? COOKIE + "=" + encodeURIComponent(value) + "; path=/; max-age=31536000; SameSite=Lax"
					: COOKIE + "=; path=/; max-age=0; SameSite=Lax";
			} catch { }
		}
		function readKeyFromDisk() {
			let value = "";
			try { value = localStorage.getItem(LS_KEY) || ""; } catch { }
			return value || readCookie();
		}
		function persistKey(value) {
			try { value ? localStorage.setItem(LS_KEY, value) : localStorage.removeItem(LS_KEY); } catch { }
			writeCookie(value);
		}

		// ── 本地采样 ────────────────────────────────────────────────
		function loadHist() {
			try {
				const raw = JSON.parse(localStorage.getItem(LS_HIST) || "[]");
				return Array.isArray(raw) ? raw.filter((x) => x && typeof x.t === "number" && typeof x.b === "number") : [];
			} catch { return []; }
		}
		function pushSample(balance) {
			const list = loadHist();
			const now = Date.now();
			const last = list[list.length - 1];
			if (!last || Math.abs(last.b - balance) > 0.004 || now - last.t > 5 * 60000) {
				list.push({ t: now, b: balance });
				try { localStorage.setItem(LS_HIST, JSON.stringify(list.filter((x) => x.t >= now - 45 * 86400000).slice(-6000))); } catch { }
			}
		}
		function consumedSince(fromMs) {
			const list = loadHist();
			let sum = 0;
			for (let i = 1; i < list.length; i++) {
				if (list[i].t < fromMs) continue;
				const drop = list[i - 1].b - list[i].b;
				if (drop > 0.004) sum += drop;
			}
			return sum;
		}
		function hasDataSince(fromMs) { return loadHist().some((x) => x.t >= fromMs); }
		function dayStart() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
		function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }

		// ── 余额 store ──────────────────────────────────────────────
		const store = { key: readKeyFromDisk(), data: null, err: "", busy: false, subs: new Set(), timer: 0 };
		function notify() { store.subs.forEach((fn) => { try { fn(); } catch { } }); }

		async function pull() {
			if (!store.key) return;
			store.busy = true; notify();
			try {
				const res = await fetch(ENDPOINT, {
					method: "GET",
					headers: { Authorization: "Bearer " + store.key, Accept: "application/json" },
					credentials: "omit", cache: "no-store",
				});
				if (res.status === 401 || res.status === 403) throw new Error("API Key 无效，请重新填写");
				if (!res.ok) throw new Error("请求失败 (HTTP " + res.status + ")");
				const json = await res.json();
				const info = (json.balance_infos || [])[0] || {};
				store.data = {
					total: Number(info.total_balance || 0),
					granted: Number(info.granted_balance || 0),
					topped: Number(info.topped_up_balance || 0),
					currency: info.currency || "CNY",
					available: json.is_available !== false,
					at: Date.now(),
				};
				store.err = "";
				// 给 HUD 插件留一份余额快照（低余额联动）
				try {
					localStorage.setItem("dsh.balance.snapshot", JSON.stringify({ total: store.data.total, at: Date.now() }));
				} catch { }
				// 校准：本次新增的「模型花费」对比「余额实际下降」
				try {
					const costs = snapshotCosts();
					if (prevCosts && lastBalance != null) {
						let modeled = 0;
						costs.forEach((v, sid) => {
							const prev = prevCosts.get(sid);
							if (prev != null && v > prev) modeled += v - prev;
						});
						const observed = Math.max(0, lastBalance - store.data.total);
						if (modeled > 0 && observed > 0) {
							cal.modeled += modeled;
							cal.observed += observed;
							cal.samples += 1;
							writeCal(cal);
						}
					}
					prevCosts = costs;
					lastBalance = store.data.total;
				} catch { }
				pushSample(store.data.total);
			} catch (e) {
				store.err = e && e.message ? e.message : "网络连接失败";
			} finally {
				store.busy = false; notify();
			}
		}

		function startPolling() {
			if (store.timer || !store.key) return;
			pull();
			store.timer = setInterval(pull, POLL_MS);
		}

		function useStore() {
			const [, bump] = React.useState(0);
			React.useEffect(() => {
				const fn = () => bump((n) => n + 1);
				store.subs.add(fn);
				startPolling();
				return () => {
					store.subs.delete(fn);
					if (store.subs.size === 0) { clearInterval(store.timer); store.timer = 0; }
				};
			}, []);
			return store;
		}

		function setKey(value) {
			persistKey(value);
			store.key = value; store.data = null; store.err = "";
			notify();
			if (value) { clearInterval(store.timer); store.timer = 0; startPolling(); }
		}

		// ── 会话用量：直接读 sessions 服务（座位不一定会注入 useSessions） ──
		let pluginCtx = null;

		function sessionsOf(ctx) {
			if (!ctx) return undefined;
			try { const s = ctx.get ? ctx.get("sessions") : ctx.sessions; if (s) return s; } catch { }
			try { return ctx.sessions; } catch { }
			return undefined;
		}

		let lastProbe = null;

		function readUsage(sid) {
			const ctx = pluginCtx;
			if (!ctx || !sid) return undefined;
			const sessions = sessionsOf(ctx);
			if (!sessions) return undefined;
			try {
				const snap0 = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
				const sum0 = snap0 && snap0.byId ? snap0.byId[sid] : undefined;
				const pv0 = sum0 && sum0.projectionValues;
				lastProbe = { sid: String(sid).slice(0, 14), hit: !!sum0, tok: pv0 ? typeof pv0.tokenUsage : "none" };
			} catch (e) { lastProbe = { err: e.message }; }

			// 路线 1：列表快照里的 projectionValues
			try {
				if (sessions.list && sessions.list.getSnapshot) {
					const snap = sessions.list.getSnapshot();
					const summary = snap && snap.byId ? snap.byId[sid] : undefined;
					const usage = summary && summary.projectionValues ? summary.projectionValues.tokenUsage : undefined;
					if (usage) return usage;
				}
			} catch { }

			// 路线 2：会话级 binding/projection face
			try {
				if (sessions.binding) {
					const binding = sessions.binding(sid);
					const projections = binding && binding.session && binding.session.projections;
					if (projections && projections.faceOf) {
						const face = projections.faceOf("tokenUsage");
						if (face) {
							const value = typeof face.get === "function" ? face.get() : (typeof face === "function" ? face() : face);
							if (value) return value;
						}
					}
				}
			} catch { }

			return undefined;
		}

		// 诊断信息（面板底部显示，用来排查为什么读不到）
		// 读取接缝处和标题栏按钮的实际计算样式（排查皮肤黑边用）
		function seamInfo() {
			try {
				const out = [];
				const pick = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
				const describe = (el, name) => {
					if (!el) { out.push(name + "=none"); return; }
					const cs = getComputedStyle(el);
					const cls = String(el.className || "").slice(0, 18);
					out.push(name + "[" + cls + "] bR=" + cs.borderRightWidth + "/" + cs.borderRightStyle +
						" bL=" + cs.borderLeftWidth + "/" + cs.borderLeftStyle +
						" bg=" + cs.backgroundColor + " sh=" + (cs.boxShadow === "none" ? "-" : cs.boxShadow.slice(0, 18)));
				};
				describe(pick('[class*="sidebarCol"]'), "sb");
				describe(pick('[class*="centerCol"]'), "cc");
				describe(pick('[class*="frame"]'), "frame");
				// 直接问浏览器：接缝那一列像素上到底是哪个元素
				const sbEl = pick('[class*="sidebarCol"]');
				if (sbEl) {
					const r = sbEl.getBoundingClientRect();
					const y = Math.round(window.innerHeight / 2);
					const at = (x, tag) => {
						const el = document.elementFromPoint(Math.round(x), y);
						if (!el) { out.push(tag + "=none"); return; }
						const cs = getComputedStyle(el);
						out.push(tag + "=" + el.tagName.toLowerCase() + "." + String(el.className || "").slice(0, 16) +
							" w=" + Math.round(el.getBoundingClientRect().width) + " bg=" + cs.backgroundColor +
							" bL=" + cs.borderLeftWidth + " bR=" + cs.borderRightWidth);
					};
					at(r.right - 30, "inSb");
					at(r.right + 30, "inCc");
					out.push("edge=" + Math.round(r.right));
					// 沿侧栏内部往上走，找出谁在画渐变（background-image）
					let cur = document.elementFromPoint(Math.round(r.right - 40), y);
					let depth = 0;
					while (cur && depth < 6) {
						const cs = getComputedStyle(cur);
						const img = cs.backgroundImage && cs.backgroundImage !== "none" ? "IMG" : "-";
						const sh = cs.boxShadow && cs.boxShadow !== "none" ? "SH" : "-";
						if (img !== "-" || sh !== "-") {
							out.push("chain" + depth + "[" + String(cur.className || cur.tagName).slice(0, 16) + "] " +
								img + sh + " " + String(cs.backgroundImage).slice(0, 60));
						}
						cur = cur.parentElement; depth++;
					}
				}
				// 侧栏内部那层（SidebarRoot）
				const slot = pick('[data-slot="sidebar"]');
				describe(slot, "slotSb");
				if (slot) {
					const cs = getComputedStyle(slot);
					out.push("sbVar=" + (cs.getPropertyValue("--dsw-specific-sidebar-fill") || "-").trim());
					describe(slot.firstElementChild, "slotKid");
				}
				// 穷举侧栏子树里所有"画了东西"的元素
				try {
					const sbSlot = pick('[data-slot="main.conversation"]') || pick('[class*="centerCol"]');
					if (sbSlot) {
						const painted = [];
						const all = sbSlot.querySelectorAll("*");
						for (let i = 0; i < all.length && painted.length < 4; i++) {
							const el = all[i];
							const cs = getComputedStyle(el);
							const bg = cs.backgroundColor;
							const m = bg.match(/rgba?\(([^)]+)\)/);
							let alpha = 1;
							if (m) { const parts = m[1].split(","); alpha = parts.length > 3 ? Number(parts[3]) : 1; }
							const hasImg = cs.backgroundImage && cs.backgroundImage !== "none";
							const blur = (cs.backdropFilter && cs.backdropFilter !== "none") || (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none");
							const rect = el.getBoundingClientRect();
							const big = (rect.width * rect.height) > (window.innerWidth * window.innerHeight * 0.15);
							if (big && (alpha > 0.01 || hasImg || blur)) {
								painted.push(String(el.tagName) + (el.getAttribute("data-slot") || "") + "|" + Math.round(rect.width) + "x" + Math.round(rect.height) + "|" + bg + "|a=" + alpha.toFixed(2) +
									(hasImg ? "|img" : "") + (blur ? "|blur:" + String(cs.backdropFilter || cs.webkitBackdropFilter).slice(0, 12) : ""));
							}
						}
						out.push("paintedC=" + (painted.length ? painted.join(" ; ") : "none"));
					}
				} catch (e) { out.push("paintErr=" + e.message); }
				describe(pick('[data-slot="main.conversation"]'), "conv");
				const cap = pick('[class*="caption"]') || pick('[class*="windowControl"]');
				out.push(cap ? "cap[" + String(cap.className || "").slice(0, 14) + "]" : "cap=none");
			return out.join(" · ");
			} catch (e) { return "probe err: " + e.message; }
		}
		function diagnose() {
			if (!pluginCtx) return "pluginCtx 为空";
			let out = [];
			try { out.push("ctx.get=" + (typeof pluginCtx.get)); } catch { }
			const sessions = sessionsOf(pluginCtx);
			out.push("sessions=" + (sessions ? "有" : "无"));
			if (sessions) {
				out.push("list=" + (sessions.list ? Object.keys(sessions.list).slice(0, 6).join("/") : "无"));
				try {
					const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
					if (snap) {
						const ids = snap.ids || Object.keys(snap.byId || {});
						out.push("count=" + ids.length);
						const first = ids[0];
						const summary = first ? snap.byId[first] : null;
						out.push("proj=" + (summary && summary.projectionValues ? Object.keys(summary.projectionValues).join(",") : "无"));
					}
				} catch (e) { out.push("snapErr=" + e.message); }
			}
			out.push("row=" + rowStats.render + "/" + rowStats.sid + "/" + rowStats.usage + "/" + rowStats.fill + " cls=" + rowStats.cls + " pct=" + rowStats.pct + " max=" + rowStats.max);
			if (lastProbe) out.push("last=" + lastProbe.sid + "/" + lastProbe.hit + "/" + lastProbe.tok);
			try { out.push(seamInfo()); } catch { }
			return out.join(" · ");
		}

		function useUsage(sid) {
			const [usage, setUsage] = React.useState(undefined);
			React.useEffect(() => {
				let alive = true;
				const read = () => { if (alive) setUsage(readUsage(sid)); };
				read();
				const t = setInterval(read, 2500);
				return () => { alive = false; clearInterval(t); };
			}, [sid]);
			return usage;
		}

		// ── 计价 ────────────────────────────────────────────────────
		// buckets: { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }
		// 缓存命中按输入单价的 1/4 计（与官方缓存价一致）。
		function costOfRaw(buckets, model, at) {
			if (!buckets) return 0;
			const table = PRICES[model === "pro" ? "pro" : "flash"];
			const factor = isPeak(at || Date.now()) ? 2 : 1;
			const hit = (buckets.cacheReadTokens || 0) * table.hit;
			const miss = ((buckets.uncachedInputTokens || 0) + (buckets.cacheWriteTokens || 0)) * table.miss;
			const out = (buckets.outputTokens || 0) * table.out;
			return ((hit + miss + out) / 1e6) * factor;
		}		// ── 按天基线：会话只算"今天"的用量 ────────────────────────
		// tokenUsage 只有累计值，所以每天首次采样时把各会话的 buckets 记成基线，
		// 之后用「当前 − 基线」得到今天的增量；当天新建的会话基线为 0（全算今天）。
		const LS_DAY = "dsh.balance.day.v2";

		function localDayKey() {
			const d = new Date();
			const m = String(d.getMonth() + 1).padStart(2, "0");
			const day = String(d.getDate()).padStart(2, "0");
			return d.getFullYear() + "-" + m + "-" + day;
		}

		function readDay() {
			try {
				const raw = JSON.parse(localStorage.getItem(LS_DAY) || "null");
				if (raw && typeof raw.d === "string" && raw.base && typeof raw.base === "object") {
					if (!raw.last) raw.last = {};
					return raw;
				}
			} catch { }
			return { d: localDayKey(), base: {}, last: {} };
		}

		let dayState = readDay();
		let daySavedAt = 0;

		function persistDay() {
			const now = Date.now();
			if (now - daySavedAt < 3000) return;
			daySavedAt = now;
			try { localStorage.setItem(LS_DAY, JSON.stringify(dayState)); } catch { }
		}

		// 跨天：昨天最后已知的累计值，就是今天的起点；这样"今日"才是真正的当天增量
		function rollDayIfNeeded() {
			const key = localDayKey();
			if (dayState.d === key) return;
			dayState = { d: key, base: Object.assign({}, dayState.last || {}), last: {} };
			persistDay();
		}

		// 每次渲染记录"最后已知累计值"，供明天当基线
		function noteLast(sid, raw) {
			if (!sid || !raw) return;
			rollDayIfNeeded();
			dayState.last[sid] = raw;
			persistDay();
		}

		function todayBuckets(sid, current) {
			if (!current) return undefined;
			rollDayIfNeeded();
			const base = dayState.base[sid];
			if (!base) return current;   // 没有昨日基线（当天新建/首次记录）→ 全算今天
			return {
				uncachedInputTokens: Math.max(0, (current.uncachedInputTokens || 0) - (base.uncachedInputTokens || 0)),
				cacheReadTokens: Math.max(0, (current.cacheReadTokens || 0) - (base.cacheReadTokens || 0)),
				cacheWriteTokens: Math.max(0, (current.cacheWriteTokens || 0) - (base.cacheWriteTokens || 0)),
				outputTokens: Math.max(0, (current.outputTokens || 0) - (base.outputTokens || 0)),
			};
		}
		// ── 自动校准 ────────────────────────────────────────────────
		// 硬编码单价永远对不上真实计费（cacheRead 占绝大多数且价差很大），
		// 所以用「余额实际下降」÷「按单价算出来的消耗」得到一个校正系数 k，
		// 之后所有会话花费都乘 k。k 只影响量级，不改变会话之间的相对比例。
		const LS_CAL = "dsh.balance.cal";

		function readCal() {
			try {
				const raw = JSON.parse(localStorage.getItem(LS_CAL) || "null");
				if (raw && raw.v === 2 && typeof raw.modeled === "number" && typeof raw.observed === "number") return raw;
			} catch { }
			return { v: 2, modeled: 0, observed: 0, samples: 0 };
		}
		function writeCal(c) { try { c.v = 2; localStorage.setItem(LS_CAL, JSON.stringify(c)); } catch { } }

		let cal = readCal();
		let prevCosts = null;   // sid -> 上次的模型花费
		let lastBalance = null; // 上次成功读到的余额

		function readModel(sid) {
			try {
				const sessions = sessionsOf(pluginCtx);
				const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
				const summary = snap && snap.byId ? snap.byId[sid] : undefined;
				return modelOf(summary && summary.projectionValues);
			} catch { return "flash"; }
		}

		function snapshotCosts() {
			const map = new Map();
			try {
				const sessions = sessionsOf(pluginCtx);
				const snap = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
				if (snap && snap.byId) {
					Object.keys(snap.byId).forEach((sid) => {
						const pv = snap.byId[sid] && snap.byId[sid].projectionValues;
						const b = pv ? bucketsOf(pv.tokenUsage) : undefined;
						if (b) map.set(sid, costOfRaw(b, modelOf(pv), Date.now()));
					});
				}
			} catch { }
			return map;
		}

		function kFactor() {
			if (!cal || cal.samples < 2 || !(cal.modeled > 0)) return 1;
			const k = cal.observed / cal.modeled;
			if (!isFinite(k) || k <= 0) return 1;
			return Math.min(1, Math.max(0.00001, k));
		}
		// 客户端拿到的是扁平 buckets；若哪天变成 { totals, last } 也能兼容
		function costOf(buckets, model, at) { return costOfRaw(buckets, model, at) * kFactor(); }

		function bucketsOf(value) {
			if (!value) return undefined;
			if (value.totals && typeof value.totals === "object") return value.totals;
			if (typeof value.uncachedInputTokens === "number" || typeof value.outputTokens === "number") return value;
			return undefined;
		}

		function tokenTotal(buckets) {
			if (!buckets) return 0;
			return (buckets.uncachedInputTokens || 0) + (buckets.cacheReadTokens || 0) +
				(buckets.cacheWriteTokens || 0) + (buckets.outputTokens || 0);
		}

		// ── 小工具 ──────────────────────────────────────────────────
		function tierOf(total) { return total < 10 ? "#ef4444" : (total > 50 ? "#22c55e" : "#f59e0b"); }
		function symbolOf(data) { return data && data.currency === "USD" ? "$" : "¥"; }
		function money(v) { return Number(v).toFixed(2); }
		function fmtCost(v) {
			if (!(v > 0)) return "";
			if (v >= 100) return "¥" + Math.round(v);
			if (v >= 10) return "¥" + v.toFixed(1);
			if (v >= 1) return "¥" + v.toFixed(2);
			return "¥" + v.toFixed(3);
		}
		function fmtTokens(n) {
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return Math.round(n / 1e3) + "k";
			return String(n);
		}

		function ensureCss() {
			try {
				if (typeof document === "undefined" || !document.head) return;
				if (document.getElementById && document.getElementById("dsh-balance-css")) return;
				const style = document.createElement("style");
				style.id = "dsh-balance-css";
				style.textContent =
										/* 皮肤接缝修复：去掉侧栏/对话两列之间那两条 0.5px 边框，并统一底色 */
					'[class*="sidebarCol"]{border-right:0!important;background:transparent!important}' +
					'[class*="centerCol"]{border-left:0!important;background:transparent!important}' +
					'[class*="rightbarCol"]{border-left:0!important;background:transparent!important}' +
					'[data-slot="main.conversation"]{background:transparent!important}' +
					'[data-windows-titlebar] button{background:transparent!important;box-shadow:none!important}' +
					/* 拖拽手柄：背景透明但伪元素/背景图仍会画出一条 4px 深线 */
					'[class*="handle"]{background:transparent!important;background-image:none!important;box-shadow:none!important;border:0!important;outline:0!important}' +
										/* 侧栏的 backdrop-filter 会在边界处产生可见的亮度接缝（透明白 + 模糊） */
					'[class*="sidebarCol"],[class*="sidebarCol"]{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' +
					'[class*="sidebarCol"] *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' +'[class*="handle"]::before,[class*="handle"]::after{content:none!important;display:none!important}' +					"@keyframes dshBalPulse{0%,100%{opacity:.35}50%{opacity:1}}" +
					".dshBalPulse{animation:dshBalPulse 1.6s ease-in-out infinite}" +
					"@keyframes dshBalSpin{to{transform:rotate(360deg)}}" +
					".dshBalSpin{animation:dshBalSpin .9s linear infinite;display:inline-block}";
				document.head.appendChild(style);
			} catch { }
		}
		ensureCss();

		// 数字滚动
		function useCountUp(target, ms) {
			const [value, setValue] = React.useState(Number(target) || 0);
			const fromRef = React.useRef(Number(target) || 0);
			const rafRef = React.useRef(0);
			React.useEffect(() => {
				const from = fromRef.current || 0;
				if (from === target || typeof requestAnimationFrame !== "function") {
					fromRef.current = target; setValue(target); return;
				}
				const started = Date.now();
				const step = () => {
					const k = Math.min(1, (Date.now() - started) / ms);
					const eased = 1 - Math.pow(1 - k, 3);
					const next = from + (target - from) * eased;
					fromRef.current = next;
					setValue(next);
					if (k < 1) rafRef.current = requestAnimationFrame(step);
				};
				rafRef.current = requestAnimationFrame(step);
				return () => { if (rafRef.current && typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafRef.current); };
			}, [target]);
			return value;
		}

		// 余额下降时闪一下
		function useDropFlash(total) {
			const prev = React.useRef(total);
			const [flash, setFlash] = React.useState(false);
			React.useEffect(() => {
				if (prev.current !== undefined && total < prev.current - 0.004) {
					setFlash(true);
					const t = setTimeout(() => setFlash(false), 700);
					prev.current = total;
					return () => clearTimeout(t);
				}
				prev.current = total;
			}, [total]);
			return flash;
		}

		// 标题栏按钮底色：preload 会读这个探针的 background-color 交给 Windows，
		// 皮肤给的是半透明值，Windows 只能取 RGB 画成不透明深块。改成 transparent 再戳一下重测。
		function syncCaptionColor() {
			try {
				if (typeof document === "undefined" || !document.body) return "no-body";
				const probe = document.querySelector('body > span[style*="--dsw-specific-sidebar-fill"]');
				if (!probe) return "no-probe";
				probe.style.setProperty("background-color", "transparent", "important");
				document.body.setAttribute("data-dsh-bal-nudge", String(Date.now()));
				setTimeout(() => {
					try { document.body.removeAttribute("data-dsh-bal-nudge"); } catch { }
				}, 40);
				return "ok";
			} catch (e) { return "err:" + e.message; }
		}
		function openPanel(ctx) {
			try {
				const layout = ctx.get ? ctx.get("layout") : ctx.layout;
				if (layout && layout.selectPanel) layout.selectPanel(ID);
			} catch { }
		}

		// ── 座位 1：聊天头部胶囊 ────────────────────────────────────
		function BalanceChip(props) {
			const state = useStore();
			const total = state.data ? state.data.total : 0;
			const shown = useCountUp(total, 600);
			const flash = useDropFlash(total);
			const low = state.data ? total < 10 : false;
			const tier = tierOf(total);
			const ratio = Math.max(0, Math.min(1, total / 100));

			if (!state.key) return null;
			const text = state.data
				? symbolOf(state.data) + shown.toFixed(2)
				: (state.err ? (state.err.indexOf("Key") >= 0 ? "Key 无效" : "余额 ?") : "…");

			return h("button", {
				type: "button",
				title: state.err ? state.err : "点击打开余额面板",
				onClick: () => { if (props && props.select) props.select(); },
				style: {
					position: "relative", overflow: "hidden",
					display: "inline-flex", alignItems: "center", gap: 6,
					height: 24, padding: "0 9px", marginRight: 2, borderRadius: 12,
					border: "1px solid color-mix(in srgb, " + tier + " " + (flash ? "90%" : "45%") + ", transparent)",
					background: flash ? "color-mix(in srgb, " + tier + " 30%, transparent)" : "color-mix(in srgb, " + tier + " 12%, transparent)",
					color: "inherit", fontSize: 12, fontVariantNumeric: "tabular-nums",
					cursor: "pointer", lineHeight: 1, transition: "background .25s ease, border-color .25s ease",
				},
			},
				h("span", {
					"aria-hidden": "true",
					style: {
						position: "absolute", left: 0, top: 0, bottom: 0, width: (ratio * 100).toFixed(1) + "%",
						background: tier, opacity: 0.16, transition: "width .5s ease",
					},
				}),
				h("span", {
					className: low ? "dshBalPulse" : undefined,
					style: { width: 6, height: 6, borderRadius: 3, background: tier, flex: "0 0 auto", position: "relative" },
				}),
				h("span", { style: { fontWeight: 600, position: "relative" } }, text)
			);
		}

		// ── 座位 2：输入框上方一行 ──────────────────────────────────
		function ComposerLine(props) {
			const state = useStore();
			const usage = useUsage(props && props.sessionId);
			const sym = symbolOf(state.data);

			const turnCost = usage && usage.last && usage.last.buckets ? costOf(usage.last.buckets) : 0;
			const totalCost = usage && usage.totals ? costOf(usage.totals) : 0;
			const today = hasDataSince(dayStart()) ? consumedSince(dayStart()) : 0;

			const bits = [];
			if (turnCost > 0) bits.push("本轮 " + fmtCost(turnCost));
			else if (totalCost > 0) bits.push("会话 " + fmtCost(totalCost));
			if (state.data) bits.push("今日 " + sym + money(today));
			if (state.data) bits.push("余额 " + sym + money(state.data.total));
			if (bits.length === 0) return null;

			return h("div", {
				style: {
					display: "flex", gap: 14, alignItems: "center", padding: "2px 4px 6px",
					fontSize: 11, opacity: 0.62, fontVariantNumeric: "tabular-nums", userSelect: "none",
				},
			}, bits.map((text, i) => h("span", { key: i }, text)));
		}

		// ── 座位 3：侧栏会话行（背景从左往右填充表达今日花费） ──────
		// 槽位只有 16×20，画不了东西；所以借这个挂载点拿到整行 DOM，
		// 用 CSS 变量控制行背景的 ::before 填充宽度。
		const rowStats = { render: 0, sid: 0, usage: 0, fill: 0, cls: "", pct: 0, max: "" };


		function SessionCostDetail(props) {
			const usage = useUsage(props && props.sessionId);
			const raw = bucketsOf(usage);
			if (!raw) return null;
			const buckets = todayBuckets(props && props.sessionId, raw);
			if (!buckets) return null;
			const cost = costOf(buckets, readModel(props && props.sessionId), Date.now());
			if (cost <= 0) return null;
			return h("div", {
				style: { fontSize: 11, opacity: 0.6, fontVariantNumeric: "tabular-nums", marginTop: 4 },
			}, "今日花费 " + fmtCost(cost) + " · " + fmtTokens(tokenTotal(buckets)) + " tokens");
		}

		// ── 座位 4：侧栏图标 ────────────────────────────────────────
		function BalanceIcon() {
			return h("svg", {
				width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
				strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				h("circle", { cx: 12, cy: 12, r: 8.6 }),
				h("path", { d: "M9 8.2h6M12 8.2v7.4M9.4 11.8h5.2" })
			);
		}
		// ── 座位 5：主面板 ──────────────────────────────────────────
		function BalancePanel() {
			const state = useStore();
			const [draft, setDraft] = React.useState("");

			const shown = useCountUp(state.data ? state.data.total : 0, 500);
			const sym = symbolOf(state.data);
			const total = state.data ? state.data.total : 0;
			const tier = tierOf(total);
			const ratio = Math.max(0, Math.min(1, total / 100));

			const header = h("div", { style: P.head },
				h("span", { style: P.title }, "DeepSeek 余额"),
				h("div", { style: { flex: 1 } }),
				h("button", { style: P.btn, onClick: pull, disabled: state.busy || !state.key },
					state.busy ? h("span", { className: "dshBalSpin", style: { marginRight: 6 } }, "⟳") : null,
					state.busy ? "刷新中…" : "刷新"),
				h("button", { style: P.btn, onClick: () => setKey("") }, "换 Key")
			);

			if (!state.key) {
				return h("div", { style: P.wrap }, header,
					h("div", { style: P.card },
						h("div", { style: { fontSize: 13, fontWeight: 600 } }, "填一个 API Key 就能显示余额"),
						h("div", { style: P.hint },
							"在 ",
							h("a", { style: P.link, href: "https://platform.deepseek.com/api_keys", target: "_blank", rel: "noreferrer" },
								"platform.deepseek.com → API keys"),
							" 创建一个 sk- 开头的密钥。它只存在这台机器上，用于直连余额接口。"),
						h("input", {
							style: P.input, type: "password", placeholder: "sk-...", value: draft,
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter" && draft.trim()) setKey(draft.trim()); },
						}),
						h("div", { style: { display: "flex", gap: 8, marginTop: 10 } },
							h("button", { style: P.btn, onClick: () => { if (draft.trim()) setKey(draft.trim()); }, disabled: !draft.trim() },
								"保存并查询")),
						state.err ? h("div", { style: P.err }, state.err) : null
					));
			}

			return h("div", { style: P.wrap }, header,
				h("div", { style: P.card },
					state.data
						? h("div", null,
							h("div", { style: { display: "flex", alignItems: "baseline", gap: 6 } },
								h("span", { style: { fontSize: 20, opacity: 0.6 } }, sym),
								h("span", {
									style: {
										fontSize: 44, fontWeight: 600, lineHeight: 1.1,
										fontVariantNumeric: "tabular-nums", color: total < 10 ? "#ffa3a3" : "inherit",
									},
								}, money(shown))),
							h("div", { style: { fontSize: 12, opacity: 0.55, marginTop: 2 } },
								"赠送 " + sym + money(state.data.granted) + " · 充值 " + sym + money(state.data.topped) +
								"　·　更新于 " + new Date(state.data.at).toTimeString().slice(0, 5)),
							h("div", {
								style: {
									position: "relative", height: 6, borderRadius: 3, marginTop: 16, overflow: "hidden",
									background: "color-mix(in srgb, currentColor 12%, transparent)",
								},
							},
								h("div", {
									style: {
										position: "absolute", left: 0, top: 0, bottom: 0, width: (ratio * 100).toFixed(1) + "%",
										borderRadius: 3, transition: "width .6s ease",
										background: "linear-gradient(90deg, " + tier + "cc, " + tier + ")",
									},
								})),
							h("div", { style: { display: "flex", gap: 28, marginTop: 18 } },
								stat("今日消耗", hasDataSince(dayStart()) ? sym + money(consumedSince(dayStart())) : "—"),
								stat("本月消耗", hasDataSince(monthStart()) ? sym + money(consumedSince(monthStart())) : "—"),
								stat("账户状态", state.data.available ? "可用" : "余额不足", state.data.available ? null : "#f87171")))
						: h("div", { style: { fontSize: 13, opacity: 0.6, padding: "18px 0" } },
							state.busy ? "正在查询…" : "还没有数据"),
					state.err ? h("div", { style: P.err }, state.err) : null,
					h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 18 } },
						h("button", {
							style: Object.assign({}, P.btn, { borderColor: "transparent", background: tier, color: "#0b1016", fontWeight: 600 }),
							onClick: () => window.open(TOPUP, "_blank", "noreferrer"),
						}, "去充值"),
						h("span", { style: { fontSize: 11, opacity: 0.45 } }, "每 60 秒自动刷新")),
					h("div", {
						style: {
							marginTop: 16, paddingTop: 14,
							borderTop: "1px solid color-mix(in srgb, currentColor 10%, transparent)",
						},
					},
						h("div", { style: { fontSize: 11, opacity: 0.5 } },
							"计费（官方价目 · " + (isPeak(Date.now()) ? "当前高峰 ×2" : "当前空闲") + "）"),
						h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 6, lineHeight: 1.7 } },
							"flash：输入 ¥1/M · 缓存命中 ¥0.02/M · 输出 ¥4/M",
							h("br"),
							"pro：输入 ¥4.5/M · 缓存命中 ¥0.15/M · 输出 ¥13.5/M"),
						h("div", { style: { fontSize: 11, opacity: 0.45, marginTop: 6 } },
							"高峰 = 周一至周五 9:00–12:00、14:00–18:00（北京时间），单价翻倍")))
				,
				h("div", { style: P.hint },
					"今日/本月消耗来自余额采样；会话花费按官方价目把 token 折算成钱，高峰时段自动 ×2。"),
				h("div", { style: { fontSize: 10, opacity: 0.35, marginTop: 12, lineHeight: 1.6, wordBreak: "break-all" } },
					"诊断：" + diagnose()));
		}

		function stat(label, value, color) {
			return h("div", null,
				h("div", { style: { fontSize: 11, opacity: 0.5, marginBottom: 4 } }, label),
				h("div", { style: { fontSize: 15, fontVariantNumeric: "tabular-nums", color: color || "inherit" } }, value));
		}

		const P = {
			wrap: { padding: "28px 32px 40px", maxWidth: 760, margin: "0 auto", fontFamily: "inherit", color: "inherit" },
			head: { display: "flex", alignItems: "center", gap: 10, marginBottom: 18 },
			title: { fontSize: 14, fontWeight: 600, letterSpacing: 0.2, opacity: 0.9 },
			btn: {
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				background: "color-mix(in srgb, currentColor 6%, transparent)",
				color: "inherit", borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer",
			},
			card: {
				border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
				background: "color-mix(in srgb, currentColor 4%, transparent)",
				borderRadius: 14, padding: "22px 24px 18px",
			},
			err: { fontSize: 12, color: "#f87171", marginTop: 10 },
			hint: { fontSize: 12, opacity: 0.6, marginTop: 8, lineHeight: 1.6 },
			input: {
				width: "100%", boxSizing: "border-box", marginTop: 8, padding: "9px 12px", borderRadius: 8,
				fontSize: 13, color: "inherit",
				border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
				background: "color-mix(in srgb, currentColor 6%, transparent)",
			},
			link: { color: "#5b9bff", cursor: "pointer", textDecoration: "none", fontSize: 12 },
		};

		// ── 注册 ────────────────────────────────────────────────────
		const inject = ["slots"];

		function apply(ctx) {
			pluginCtx = ctx;
			try { syncCaptionColor(); setTimeout(syncCaptionColor, 1200); } catch { }
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "balance-chip", order: 15,
					inject: () => ({ select: () => openPanel(ctx) }),
				}, BalanceChip));

			ctx.slots.inject("sidebar.session.row.hover", () =>
				ctx.slots.register({
					name: "sidebar.session.row.hover",
					id: "balance-cost-detail", order: 20,
				}, SessionCostDetail));

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: ID, order: 30, label: () => "余额" }, BalanceIcon));

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: ID }, BalancePanel));
		}

		exports.apply = apply;
		exports.__test = { readUsage, costOf, tokenTotal };
		exports.inject = inject;
		return module.exports;
	}
});
