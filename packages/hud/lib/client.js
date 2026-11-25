/**
 * dsh-plugin-hud — 科幻背景与状态光效。
 *
 * 职责：
 *   1. 接管整窗背景（frame/三列透明），铺一层自己的能量场 + 数据流 + 扫描线
 *   2. 用会话 token 增量推断「思考 / 输出 / 空闲」，驱动色相与动效
 *   3. 侧栏会话行流光、输入框上方充能条、打字涟漪
 *   4. 侧栏「HUD」入口 + 设置面板（强度、分层开关、配色、余额联动）
 *
 * 所有视觉元素都挂在 #dsh-hud-root 这一个 fixed 图层里，不参与宿主布局，
 * 因此不会产生列与列之间的接缝。
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-hud",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const ID = "hud";
		const LS = "dsh.hud.settings";
		const BAL_SNAP = "dsh.balance.snapshot";

		// ── 设置 ────────────────────────────────────────────────────
		const DEFAULTS = {
			intensity: 55,   // 0-100
			plasma: true,
			rain: true,
			rows: true,
			bar: true,
			debug: false,
			ripple: true,
			ring2: true,     // 副环（反向旋转的那一圈）
			particles: true, // 背景粒子层
			grid: true,      // 透视网格
			// ── 动效时序（面板可调，以下为默认值）──
			breath: 1.9,     // 输出中呼吸周期（秒）
			hold: 900,       // 完成后停留多久开始淡出（毫秒）
			fade: 1350,      // 淡出时长（毫秒）
			ringSpin: 1.45,  // 光环转一圈（秒）
			hueDur: 0.55,    // 状态色过渡（秒）
			edge: 45,        // 填充底边亮度（0 = 关闭）
		};
		function readSettings() {
			try {
				const raw = JSON.parse(localStorage.getItem(LS) || "null");
				if (raw && typeof raw === "object") return Object.assign({}, DEFAULTS, raw);
			} catch { }
			return Object.assign({}, DEFAULTS);
		}
		function writeSettings(v) {
			try { localStorage.setItem(LS, JSON.stringify(v)); } catch { }
		}
		let settings = readSettings();

		// ── 色相（HSL 的 H 值） ─────────────────────────────────────
		// 空闲=低饱和冷灰蓝（几乎无色），青蓝专门表示"正在输入"
		const HUE = { idle: 212, typing: 188, think: 262, stream: 26 };

		// ── 运行状态 ────────────────────────────────────────────────
		let phase = "idle";          // idle | think | stream
		let lastActivityAt = 0;
		let lastTypingAt = 0;
		let pluginCtx = null;
		const prevTokens = new Map();   // sid -> buckets
		const listeners = new Set();      // tick 后通知行组件重算
		let powerLevel = 0;               // 0..1 输出进度
		let turnOut = 0;                  // 本轮已输出 token
		let fadeAt = 0;                   // 进入 idle 的时间
		let lastUserCount = -1;           // 用户消息条数（识别新回合最可靠的信号）
		let lastTailCount = -1;           // 已完成回合数（turnTail 出现即一轮结束）
		function tailCount() {
			try { return document.querySelectorAll('[data-slot="conversation.chat.turnTail"]').length; } catch { return -1; }
		}
		let turnSid = "";                 // 本轮锁定的会话 id（切换会话不跟随）
		let turnSeed = 0;                 // 本轮随机相位，让每次填充的节奏略有不同
		const events = [];                // 状态变迁日志
		function logEvent(msg) {
			const t = new Date();
			const hh = String(t.getHours()).padStart(2, "0");
			const mm = String(t.getMinutes()).padStart(2, "0");
			const ss = String(t.getSeconds()).padStart(2, "0");
			events.push(hh + ":" + mm + ":" + ss + " " + msg);
			if (events.length > 14) events.shift();
		}

		let turn = "idle";                // idle | typing | pending | answering | flushing
		let flushUntil = 0;               // 补满停留截止时间
		let lastSig = "";
		function notifyTicks(force) {
			const sig = phase + "|" + Math.round(powerLevel * 16);
			if (!force && sig === lastSig) return;
			lastSig = sig;
			listeners.forEach((fn) => { try { fn(); } catch { } });
		}

		function sessionsOf(ctx) {
			if (!ctx) return undefined;
			try { const s = ctx.get ? ctx.get("sessions") : ctx.sessions; if (s) return s; } catch { }
			try { return ctx.sessions; } catch { }
			return undefined;
		}

		// 会话运行状态源：优先从 slot props 的 useSessionStatus 钩子拿
		let reactStatusMap = null;
		let statusRawType = "未调用";
		let statusHookFound = false;

		function captureStatusHook(props) {
			try {
				if (!props) return;
				const fn = props.useSessionStatus || props.useSessionStates || props.useSessionStatuses;
				if (typeof fn === "function") {
					statusHookFound = true;
					const v = fn(function (s) { return s; });
					statusRawType = (v === null) ? "null" : (v instanceof Map ? "Map" : typeof v);
					if (v && typeof v === "object") {
						const m = (v instanceof Map) ? v : new Map(Object.entries(v));
						if (m.size) reactStatusMap = m;
						statusRawType += " size=" + m.size;
					}
					return;
				}
				const direct = props.sessionStatus || props.sessionStates;
				if (direct && typeof direct.getSnapshot === "function") {
					statusHookFound = true;
					const v = direct.getSnapshot();
					statusRawType = (v instanceof Map) ? "Map(snap)" : typeof v;
					if (v) reactStatusMap = (v instanceof Map) ? v : new Map(Object.entries(v));
				}
			} catch (e) {
				statusRawType = "err:" + (e && e.message ? String(e.message).slice(0, 40) : "?");
			}
		}

		// 会话运行状态源（DSH 提供：running / pendingInteraction / completionUnread）
		function statusOf(ctx) {
			if (!ctx) return null;
			try { const st = ctx.get ? ctx.get("sessionStatus") : ctx.sessionStatus; if (st && st.getSnapshot) return st; } catch { }
			try { const st = ctx.sessionStatus; if (st && st.getSnapshot) return st; } catch { }
			return null;
		}

		function statusSnapshot() {
			try {
				if (reactStatusMap && reactStatusMap.size) return reactStatusMap;
				const st = statusOf(pluginCtx);
				const snap = st && st.getSnapshot ? st.getSnapshot() : null;
				return snap instanceof Map ? snap : null;
			} catch { return null; }
		}

		function snapshot() {
			try {
				const sessions = sessionsOf(pluginCtx);
				const s = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
				return s && s.byId ? s : null;
			} catch { return null; }
		}

		function bucketsOf(pv) {
			const t = pv ? pv.tokenUsage : undefined;
			if (!t || typeof t !== "object") return undefined;
			if (t.totals) return t.totals;
			return t;
		}

		// ── 背景图层 ────────────────────────────────────────────────
		let canvas = null;
		let ctx2d = null;
		let vw = 0, vh = 0;
		let rafId = 0;
		let lastFrame = 0;
		let hueNow = HUE.idle;

		function ensureRoot() {
			if (typeof document === "undefined" || !document.body) return null;
			let root = document.getElementById("dsh-hud-root");
			if (root) return root;
			root = document.createElement("div");
			root.id = "dsh-hud-root";
			root.setAttribute("aria-hidden", "true");
			root.innerHTML =
				'<div class="hud-plasma"></div>' +
				'<canvas class="hud-rain"></canvas>' +
				'<div class="hud-scan"></div>' +
				'<div class="hud-scrim"></div>' +
				'<div class="hud-vignette"></div>';
			document.body.insertBefore(root, document.body.firstChild);
			return root;
		}

		function resizeCanvas() {
			if (!canvas) return;
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			vw = window.innerWidth;
			vh = window.innerHeight;
			canvas.width = Math.round(vw * dpr);
			canvas.height = Math.round(vh * dpr);
			canvas.style.width = vw + "px";
			canvas.style.height = vh + "px";
			ctx2d = canvas.getContext("2d");
			if (ctx2d) ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
			initColumns();
		initParticles();
		}

		const BASE_HUE = 188;   // 背景数据流固定底色
		const GLYPHS = "01<>[]{}/\\|+=*#%$@&".split("");
		const COL_W = 20;
		let columns = [];

		// 粒子层：缓慢上浮的微光点，给背景一点纵深
		let particles = [];
		function initParticles() {
			particles = [];
			const n = Math.max(18, Math.min(70, Math.round((vw * vh) / 34000)));
			for (let i = 0; i < n; i++) {
				particles.push({
					x: Math.random() * vw,
					y: Math.random() * vh,
					r: 0.6 + Math.random() * 1.5,
					vy: -(3 + Math.random() * 12),
					vx: (Math.random() - 0.5) * 5,
					a: 0.12 + Math.random() * 0.30,
				});
			}
		}

		function initColumns() {
			columns = [];
			const n = Math.max(12, Math.ceil(vw / COL_W));
			for (let i = 0; i < n; i++) {
				columns.push({
					x: i * COL_W + 4,
					y: Math.random() * vh,
					speed: 18 + Math.random() * 34,
					len: 5 + Math.floor(Math.random() * 10),
					accent: i % 2 === 0,   // 每两列有一条用状态色
				});
			}
		}

		function speedFactor() {
			if (!settings.rain) return 0;
			if (phase === "stream") return 1.75;
			if (phase === "think") return 1.05;
			return 0.32;
		}

		// 背景场景绘制：主画布与面板预览共用同一套逻辑，保证观感一致
		function drawScene(c, w, h, dt, cols, ptc, hue, strength, withText) {
			try {
				c.clearRect(0, 0, w, h);
				c.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";

				// ① 透视网格：越靠下越密、越亮
				if (settings.grid !== false) {
					const rows = 10;
					c.lineWidth = 1;
					for (let i = 0; i < rows; i++) {
						const t = (i + 1) / rows;
						const y = h * Math.pow(t, 2.3);
						const a = 0.10 * strength * t;
						c.strokeStyle = "hsla(" + BASE_HUE + ",92%,66%," + a.toFixed(3) + ")";
						c.beginPath();
						c.moveTo(0, y);
						c.lineTo(w, y);
						c.stroke();
					}
				}

				// ② 粒子层：缓慢上浮的微光点
				if (settings.particles !== false && ptc.length) {
					for (const p of ptc) {
						p.x += p.vx * dt;
						p.y += p.vy * dt;
						if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
						if (p.x < -8) p.x = w + 8;
						if (p.x > w + 8) p.x = -8;
						c.fillStyle = "hsla(" + BASE_HUE + ",96%," + (p.bright ? 84 : 72) + "%," + Math.min(1, p.a * strength * 1.8).toFixed(3) + ")";
						c.fillRect(p.x, p.y, p.r, p.r);
					}
				}

				if (!withText) return;

				// ③ 数据流
				for (const col of cols) {
					for (let k = 0; k < col.len; k++) {
						const y = col.y - k * 14;
						if (y < -16 || y > h + 16) continue;
						const g = GLYPHS[(Math.random() * GLYPHS.length) | 0];
						const isAccent = col.accent && hue !== BASE_HUE;
						const useHue = isAccent ? hue : BASE_HUE;
						const boost = isAccent ? 1.55 : 1;
						if (k === 0) {
							c.shadowBlur = isAccent ? 12 : 7;
							c.shadowColor = "hsla(" + useHue + ",98%,72%," + (0.85 * strength).toFixed(2) + ")";
							c.fillStyle = "hsla(" + useHue + ",97%,78%," + Math.min(1, 0.95 * strength * boost).toFixed(2) + ")";
						} else {
							if (k === 1) c.shadowBlur = 0;
							const a = Math.max(0, (0.42 - k * 0.032)) * strength * boost;
							c.fillStyle = "hsla(" + useHue + ",94%,60%," + Math.min(1, a).toFixed(2) + ")";
						}
						c.fillText(g, col.x, y);
					}
				}
				c.shadowBlur = 0;
			} catch { }
		}

		function drawRain(dt) {
			if (!ctx2d) return;
			const mul = speedFactor();
			if (mul === 0) { ctx2d.clearRect(0, 0, vw, vh); return; }
			const strength = 0.35 + (settings.intensity / 100) * 0.65;
			const activeHue = (phase === "typing" || phase === "think" || phase === "stream")
				? (HUE[phase] || BASE_HUE) : BASE_HUE;
			for (const c of columns) {
				c.y += c.speed * mul * dt;
				if (c.y - c.len * 14 > vh) { c.y = -Math.random() * 260; }
			}
			drawScene(ctx2d, vw, vh, dt * mul, columns, particles, activeHue, strength, true);
		}

		function frameLoop(now) {
			rafId = requestAnimationFrame(frameLoop);
			const dt = Math.min(0.2, (now - lastFrame) / 1000 || 0.016);
			if (now - lastFrame < 50) return;   // 20fps 上限
			lastFrame = now;
			drawRain(dt);
		}

		// ── 状态机 ──────────────────────────────────────────────────
		function updateBadge() {
			try {
				if (typeof document === "undefined" || !settings.debug) {
					const old = document.getElementById("dsh-hud-badge");
					if (old) old.remove();
					return;
				}
				let el = document.getElementById("dsh-hud-badge");
				if (!el) {
					el = document.createElement("div");
					el.id = "dsh-hud-badge";
					el.style.cssText =
						"position:fixed;right:10px;bottom:10px;z-index:99999;pointer-events:none;" +
						"font:11px/1.5 ui-monospace,monospace;color:#9fe9ff;background:rgba(4,10,16,.82);" +
						"border:1px solid rgba(120,220,255,.35);border-radius:6px;padding:4px 8px;white-space:pre";
					document.body.appendChild(el);
				}
				const row = findTargetRow();
				el.textContent =
					"phase " + phase +
					"\\npower " + powerLevel.toFixed(2) +
					"\\nrow   " + (rowFindMode || "none") +
					"\\nturn  " + turn +
					"\\nbtn " + document.querySelectorAll('[data-slot="conversation.composer"] button').length;
			} catch { }
		}

		// 把设置里的时长写成 CSS 变量，并同步给 JS 侧的时序常量
		function applyTiming() {
			try {
				const r = document.documentElement;
				const breath = Number(settings.breath) || 1.9;
				const fade = Number(settings.fade) || 1350;
				r.style.setProperty("--hud-breath", breath + "s");
				r.style.setProperty("--hud-fade", (fade / 1000) + "s");
				r.style.setProperty("--hud-ring-spin", (Number(settings.ringSpin) || 1.45) + "s");
				r.style.setProperty("--hud-hue-dur", (Number(settings.hueDur) || 0.55) + "s");
				const edge = Number(settings.edge);
				const e = isNaN(edge) ? 45 : edge;
				r.style.setProperty("--hud-edge-a", String(Math.min(1, e / 100)));
				r.style.setProperty("--hud-edge-w", e > 0 ? (1 + (e / 100) * 1.5).toFixed(1) + "px" : "0px");
				DONE_HOLD = Number(settings.hold) || 900;
				FADE_MS = fade;
			} catch { }
		}

		function applyVisualState() {
			if (typeof document === "undefined") return;
			const body = document.body;
			if (!body) return;
			const shown = phase;
			body.setAttribute("data-hud-state", shown);
			const target = HUE[shown] || HUE.idle;
			const root = document.documentElement;
			root.style.setProperty("--hud-h", String(target));
			root.style.setProperty("--hud-strength", String(0.35 + (settings.intensity / 100) * 0.85));
			applyTiming();
		}


		// 聊天区有文字在增长 = 正在输出（比 token 投影实时得多）


		// 一轮是否已输出过（决定还能不能回到"思考"）
		let phaseEnteredAt = 0;
		let pendingSince = 0;      // 上一轮发送时间；未开始输出前一直算"思考"
		let lastClickedSid = "";   // 最近点过的会话行
		let forced = "";           // 预览：强制状态
		let forcedUntil = 0;

		function forceState(name, ms) {
			forced = name;
			forcedUntil = Date.now() + (ms || 6000);
			phase = name;
			applyVisualState();
			// 预览不动真实会话行
			notifyTicks(true);
		}


		// 深度思考时推理文字也是流式的，不能算作"输出答案"
		function reasoningVisible() {
			try {
				return !!document.querySelector(
					'[data-slot*="reason"], [data-slot*="thinking"], [class*="reasoning"], [class*="thinking"]'
				);
			} catch { return false; }
		}

		// 对话区文字长度（扣掉推理块），用于判断"答案在增长"

		function reasonInfo() {
			try {
				const r = document.querySelector('[data-slot*="reason" i], [class*="reason" i], [class*="think" i], [data-slot*="think" i]');
				return r ? ("有" + (r.textContent || "").length) : "无";
			} catch { return "?"; }
		}

		// 只测最后一条消息节点的增长：我的回答从 0 开始长，你的提问在更早的节点里
		let lastNodeEl = null;
		let lastNodeLen = 0;
		function answerDelta() {
			try {
				const nodes = document.querySelectorAll('[data-slot="conversation.chat.node"]');
				if (!nodes.length) return 0;
				const el = nodes[nodes.length - 1];
				// 最后一条若是你的消息，不算答案增长
				if (el.querySelector && el.querySelector('[data-slot*="user"]')) {
					lastNodeEl = el; lastNodeLen = -1; return 0;
				}
				const len = (el.textContent || "").length;
				if (el !== lastNodeEl || lastNodeLen < 0) { lastNodeEl = el; lastNodeLen = len; return 0; }
				const d = len - lastNodeLen;
				lastNodeLen = len;
				return d;
			} catch { return 0; }
		}

		function domPhase() {
			try {
				const el = document.querySelector("[data-phase]");
				return el ? el.getAttribute("data-phase") : "";
			} catch { return ""; }
		}

		// 当前选中的会话行（[data-row-key="session:xxx"][aria-selected="true"]）
		function selectedSessionId() {
			try {
				const el = document.querySelector('[data-row-key][aria-selected="true"]');
				const key = el && el.getAttribute("data-row-key");
				if (key && key.indexOf("session:") === 0) return key.slice(8);
				return lastClickedSid || "";
			} catch { return lastClickedSid || ""; }
		}

		function onClickPickRow(e) {
			try {
				const row = e.target && e.target.closest ? e.target.closest("[data-row-key]") : null;
				const key = row && row.getAttribute("data-row-key");
				if (key && key.indexOf("session:") === 0) lastClickedSid = key.slice(8);
			} catch { }
		}

		// 会话行上色：每个 tick 直接操作 DOM，不依赖组件重渲染
		let rowFindMode = "";   // 目标行的定位方式（诊断用）

		function findTargetRow() {
			const rows = document.querySelectorAll("[data-row-key]");
			const isSession = (el) => {
				const k = el.getAttribute("data-row-key") || "";
				return k.indexOf("session:") === 0;
			};
			// ① 语义选中态
			for (let i = 0; i < rows.length; i++) {
				if (isSession(rows[i]) && rows[i].getAttribute("aria-selected") === "true") {
					rowFindMode = "aria";
					return rows[i];
				}
			}
			// ② 样式选中态（DSH 用 class 表达选中）
			for (let i = 0; i < rows.length; i++) {
				const cls = String(rows[i].className || "");
				if (isSession(rows[i]) && /(^|[\s_])selected([\s_]|$)/.test(cls)) {
					rowFindMode = "class";
					return rows[i];
				}
			}
			// ③ 最近点过的会话
			if (lastClickedSid) {
				for (let i = 0; i < rows.length; i++) {
					if (rows[i].getAttribute("data-row-key") === "session:" + lastClickedSid) {
						rowFindMode = "click";
						return rows[i];
					}
				}
			}
			// ④ 兜底：第一条会话行
			for (let i = 0; i < rows.length; i++) {
				if (isSession(rows[i])) { rowFindMode = "first"; return rows[i]; }
			}
			rowFindMode = "";
			return null;
		}

		// 行光效用自己的覆盖层绘制，宿主行重渲染不会影响它
		function rowFxLayer() {
			let el = document.getElementById("dsh-hud-rowfx");
			if (el) return el;
			el = document.createElement("div");
			el.id = "dsh-hud-rowfx";
			el.setAttribute("aria-hidden", "true");
			el.innerHTML = '<i class="hud-fx-ring"></i><i class="hud-fx-bar"></i>';
			document.body.appendChild(el);
			return el;
		}


		// 悬停扫描线：鼠标经过会话行时，一道细光自上而下扫过
		let hoverEl = null;
		let hoverSid = "";
		function hoverSweep(row) {
			try {
				if (!row) return;
				const key = rowKeyOf(row);
				if (!key || key === hoverSid) return;
				hoverSid = key;
				const rect = row.getBoundingClientRect();
				const layer = rowFxLayer();
				if (!hoverEl) {
					hoverEl = document.createElement("i");
					hoverEl.className = "hud-fx-hover";
					layer.appendChild(hoverEl);
				}
				hoverEl.style.cssText =
					"left:" + rect.left + "px;top:" + rect.top + "px;" +
					"width:" + rect.width + "px;height:" + rect.height + "px;";
				hoverEl.classList.remove("on");
				void hoverEl.offsetWidth;
				hoverEl.classList.add("on");
			} catch { }
		}

		function onPointerOver(e) {
			try {
				const t = e.target;
				if (!t || !t.closest) return;
				const row = t.closest('[data-row-key^="session:"]');
				if (row) hoverSweep(row);
				else hoverSid = "";
			} catch { }
		}

		function rowKeyOf(el) {
			if (!el) return "";
			const k = el.getAttribute && el.getAttribute("data-row-key");
			return k || "";   // 原样保存，不假设格式
		}

		function findRowBySid(key) {
			if (!key) return null;
			try {
				const rows = document.querySelectorAll("[data-row-key]");
				for (let i = 0; i < rows.length; i++) {
					if (rows[i].getAttribute("data-row-key") === key) return rows[i];
				}
			} catch { }
			return null;
		}

		// ── 发送按钮探测：一轮进行中，"发送"会变成"停止" ──────────
		let lastStopState = null;   // null=未知, false=空闲, true=运行中

		function composerSendButton() {
			try {
				const box = document.querySelector('[data-slot="conversation.composer"]');
				if (!box) return null;
				const btns = box.querySelectorAll("button");
				if (!btns.length) return null;
				// 发送/停止通常是最后一个按钮
				return btns[btns.length - 1];
			} catch { return null; }
		}

		function isStopButton(b) {
			if (!b) return null;
			try {
				const label = ((b.getAttribute("aria-label") || "") + " " +
					(b.getAttribute("title") || "") + " " +
					(b.getAttribute("data-testid") || "")).toLowerCase();
				if (/stop|abort|中断|停止|中止|结束|生成中/.test(label)) return true;
				if (/send|submit|发送|提交|提问/.test(label)) return false;

				const svg = b.querySelector("svg");
				if (!svg) return null;
				// 停止图标通常是实心方块/圆点，发送是箭头
				if (svg.querySelector("rect, polygon")) return true;
				const paths = svg.querySelectorAll("path");
				const d = paths.length ? (paths[0].getAttribute("d") || "") : "";
				if (!d) return null;
				// 箭头路径长，方块路径短
				if (d.length < 30) return true;
				return false;
			} catch { return null; }
		}

		// 时序常量（后续会接到设置面板）
		const DEMO_KEY = "__demo__";   // 预览用的虚拟会话 key

		let FILL_MS = 3000;      // 填充进度条所需时间（毫秒）
		let DONE_HOLD = 900;     // done 停留多久开始淡出
		let FADE_MS = 1350;      // 淡出时长

		// ── 每个会话一份状态 + 一组覆盖元素（支持多会话同时进行）──
		const sessionFx = new Map();   // key -> { ring, bar, phase, startAt, seed, doneAt }

		function fxFor(key) {
			let fx = sessionFx.get(key);
			if (fx) return fx;
			const layer = rowFxLayer();
			const make = function (cls) {
				const el = document.createElement("i");
				el.className = cls;
				el.dataset.sid = key;
				el.style.opacity = "0";
				layer.appendChild(el);
				return el;
			};
			fx = {
				ring: make("hud-fx-ring"),
				ring2: make("hud-fx-ring2"),
				bar: make("hud-fx-bar"),
				glow: make("hud-fx-glow"),
				phase: "", startAt: 0, seed: Math.random() * 6.28, doneAt: 0,
			};
			sessionFx.set(key, fx);
			return fx;
		}

		function dropFx(key) {
			const fx = sessionFx.get(key);
			if (!fx) return;
			["ring", "ring2", "bar", "glow", "sweep"].forEach(function (k) {
				const el = fx[k];
				if (el && el.parentNode) el.parentNode.removeChild(el);
			});
			sessionFx.delete(key);
		}

		// 状态切换时的全屏扫光（很淡，不抢视线）
		let flashAt = 0;
		// 行内扫光：只在这一行扫过，不影响其他会话
		function rowSweep(key, rect, fx) {
			try {
				if (!fx.sweep) {
					const layer = rowFxLayer();
					const el = document.createElement("i");
					el.className = "hud-fx-rowsweep";
					el.dataset.sid = key;
					layer.appendChild(el);
					fx.sweep = el;
				}
				const el = fx.sweep;
				el.style.cssText =
					"left:" + rect.left + "px;top:" + rect.top + "px;" +
					"width:" + rect.width + "px;height:" + rect.height + "px;clip-path: inset(0 round 9px);";
				el.classList.remove("on");
				void el.offsetWidth;
				el.classList.add("on");
			} catch { }
		}

		// done / fade 是终态：任何驱动都不得把它改回进行中，否则进度会回退
		function isTerminal(fx) { return fx.phase === "done" || fx.phase === "fade" || fx.phase === "dead"; }

		// 收尾墓碑：某会话刚播完补满/扫光，短时间内不允许任何驱动重新开一轮
		const tomb = new Map();
		function tombstoned(key) {
			const t = tomb.get(key);
			return !!t && Date.now() - t < 20000;
		}

		// 结束一轮时把本地回合状态也归位，否则后续打字会被判成"仍在输出"
		function markFinished(key) {
			if (!key) return;
			if (key === turnSid) { turn = "idle"; turnSid = ""; }
		}

		function drawOne(key, fx, now) {
			const row = (key === DEMO_KEY) ? document.querySelector(".hud-demo") : findRowBySid(key);
			if (!row) {
				// 找不到行：所有元素都要隐藏，否则会残留在旧位置
				["ring", "ring2", "bar", "glow", "sweep"].forEach(function (k) {
					if (fx[k]) fx[k].style.opacity = "0";
				});
				return;
			}
			const rect = row.getBoundingClientRect();
			const phase = fx.phase;
			if (fx.lastPhase !== phase) {
				fx.lastPhase = phase;
				if (phase === "stream" || phase === "done") rowSweep(key, rect, fx);
				// 进入收尾态时留一个墓碑：元素销毁后驱动不得立刻重建，否则补满+扫光会反复重播
				if (phase === "done") tomb.set(key, now);
			}
			const pos = "left:" + rect.left + "px;top:" + rect.top + "px;" +
				"width:" + rect.width + "px;height:" + rect.height + "px;";
			const isThink = phase === "think";

			fx.ring.style.cssText = pos + "opacity:" + (isThink ? "1" : "0");
			fx.ring2.style.cssText = pos + "opacity:" + (isThink && settings.ring2 ? "0.65" : "0");

			let power = 0;
			if (phase === "stream") {
				if (!fx.fillStart) fx.fillStart = now;
				if (key === DEMO_KEY) {
					// 预览：固定 3 秒填满，方便看完整一轮
					power = Math.min(1, (now - fx.fillStart) / FILL_MS);
				} else {
					// 正式：指数逼近，一直在缓慢前进，不会卡在某个数字上
					const dt = Math.max(0, (now - fx.fillStart) / 1000);
					power = 0.92 * (1 - Math.exp(-dt / 34));
				}
				// 两者都叠一点随机呼吸偏移，避免机械感
				power += 0.010 * Math.sin(now / 620 + fx.seed);
				power = Math.max(0.04, Math.min(key === DEMO_KEY ? 1 : 0.93, power));
			} else if (phase === "done" || phase === "fade") {
				power = 1;
			} else {
				fx.fillStart = 0;
			}

			const showBar = phase === "stream" || phase === "done" || phase === "fade";
			const fading = phase === "fade";
			const bw = showBar ? Math.max(2, rect.width * power) : 0;

			fx.bar.style.cssText =
				"left:" + rect.left + "px;top:" + rect.top + "px;" +
				"width:" + bw + "px;height:" + rect.height + "px;" +
				"opacity:" + (showBar ? "1" : "0");
			// 完成瞬间给条打一个标记，触发白光扫过
			if (phase === "done") {
				if (fx.bar.dataset.done !== "1") { fx.bar.dataset.done = "1"; }
			} else if (fx.bar.dataset.done) {
				delete fx.bar.dataset.done;
			}

			// 活跃行呼吸光：整行一层很淡的光晕
			const isActive = phase === "think" || phase === "stream";
			fx.glow.style.cssText = pos + "opacity:" + (isActive ? "1" : "0");
		}

		// 由 DSH 的 sessionStatus（每个会话的 running）驱动，天然支持多会话并行
		// 从侧栏行自身读状态：状态点带一个视觉隐藏的标签文本，始终存在
		// 中文：进行中 / 已完成 / 空闲 / 等待审批 …；英文：Running / Completed / Idle
		function rowState(row) {
			try {
				const t = (row.textContent || "");
				if (t.indexOf("进行中") >= 0 || t.indexOf("子智能体运行中") >= 0 || t.indexOf("Running") >= 0) return "running";
				if (t.indexOf("等待审批") >= 0 || t.indexOf("等待回答") >= 0 || t.indexOf("计划待审") >= 0) return "pending";
				if (t.indexOf("已完成") >= 0 || t.indexOf("Completed") >= 0) return "done";
				return "idle";
			} catch { return "idle"; }
		}

		function syncFromRows(now) {
			const rows = document.querySelectorAll('[data-row-key^="session:"]');
			for (let i = 0; i < rows.length; i++) {
				const key = rowKeyOf(rows[i]);
				if (!key) continue;
				const st = rowState(rows[i]);
				const fx = sessionFx.get(key);

				if (st === "running" || st === "pending") {
				if (fx && isTerminal(fx)) continue;   // 终态不再复活
					if (tombstoned(key)) continue;      // 刚播完收尾，别立刻重来
					const f = fx || fxFor(key);
					if (f.phase !== "think" && f.phase !== "stream") { f.startAt = now; f.doneAt = 0; }
					f.phase = (now - f.startAt < 3000) ? "think" : "stream";
					f.rowSeen = true;          // 这一行确实显示过"运行中"
					if (!f.src || f.src === "turn") f.src = "row";
				} else if (fx && fx.rowSeen && fx.phase !== "fade" && (st === "done" || st === "idle")) {
					// 只有之前确实看到过"运行中"，消失后才算结束（避免误杀）
					fx.phase = "done";
					fx.doneAt = now;
					fx.rowSeen = false;
				}
			}
		}

		function syncFromStatus(snap, now) {
			snap.forEach(function (st, sid) {
				const key = "session:" + sid;
				const running = !!(st && st.running);
				if (running) {
				const ex = sessionFx.get(key);
				if (ex && isTerminal(ex)) return;   // 终态不再复活
					if (tombstoned(key)) return;        // 刚播完收尾，别立刻重来
					const fx = fxFor(key);
					if (fx.phase !== "think" && fx.phase !== "stream") {
						fx.startAt = now;
						fx.doneAt = 0;
						fx.phase = "think";
					}
					if (fx.phase === "think" && now - fx.startAt > 5000) fx.phase = "stream";
				} else {
					const fx = sessionFx.get(key);
					if (fx && (fx.phase === "think" || fx.phase === "stream")) {
						fx.phase = "done";
						fx.doneAt = now;
						}
				}
			});
		}

		function paintAll(now) {
			try {
				const stale = [];
				sessionFx.forEach(function (fx, key) {
					// 兜底自毁，任何异常状态最多存活 3 分钟
					if (!isTerminal(fx) && fx.startAt && now - fx.startAt > 180000) {
						fx.phase = "done";
						fx.doneAt = now;
					}
					// done 停留后进入 fade —— 这一步才会真正产生透明度渐变
					if (fx.phase === "done" && fx.doneAt && now - fx.doneAt > DONE_HOLD) {
						fx.phase = "fade";
						fx.fadeAt = now;
					}
					drawOne(key, fx, now);
					if (fx.phase === "fade" && fx.fadeAt && now - fx.fadeAt > FADE_MS + 300) {
						fx.phase = "dead";     // 静默期：挡住"标签滞后"导致的复活
						fx.deadAt = now;
					}
					if (fx.phase === "dead" && fx.deadAt && now - fx.deadAt > 2500) stale.push(key);
				});
				for (let i = 0; i < stale.length; i++) dropFx(stale[i]);

			} catch { }
		}

		const diagLog = [];            // 诊断历史（变化时记录）
		// 本地探针上报（自测用，正式版会移除）
		const PROBE = "http://127.0.0.1:7788/ev";
		function report(txt) {
			try {
				fetch(PROBE, { method: "POST", body: String(txt), keepalive: true }).catch(function () {
					try { new Image().src = PROBE + "?d=" + encodeURIComponent(String(txt)); } catch { }
				});
			} catch {
				try { new Image().src = PROBE + "?d=" + encodeURIComponent(String(txt)); } catch { }
			}
		}
		function pushDiag(txt) {
			try {
				const d = new Date();
				const p2 = function (n) { return String(n).padStart(2, "0"); };
				diagLog.push(p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + " " + txt);
				if (diagLog.length > 40) diagLog.shift();
				// 自测探针（本地 7788），失败静默
				try {
					fetch("http://127.0.0.1:7788/ev", { method: "POST", body: String(txt), keepalive: true })
						.catch(function () { });
				} catch { }
			} catch { }
		}
		let statusKeysSample = "";      // 状态对象的字段名采样
		let lastDiag = "";
		const HUD_BUILD = "1125-0420";
		let fxDiag = "init";

		// 当前会话：本地状态机 → 直接写它自己的 fx（不等官方 running）
		function applyCurrentTurn(next, now) {
			try {
				const key = turnSid || rowKeyOf(findTargetRow());
				if (!key) return;
				if (next === "think" || next === "stream") {
				if (next === "think" || next === "stream" || next === "done" || next === "idle") {
					const ex = sessionFx.get(key);
					if (ex && isTerminal(ex)) return;   // 终态不再复活
						if (tombstoned(key)) return;        // 刚播完收尾，别立刻重来
				}
					const fx = fxFor(key);
					if (fx.phase !== "think" && fx.phase !== "stream") {
						fx.startAt = now;
						fx.src = "turn";
					}
					fx.phase = next;
					fx.doneAt = 0;
				} else if (next === "done" || next === "idle") {
					const fx = sessionFx.get(key);
					// 只收尾本地状态机自己创建的那一份，状态源/行驱动的由它们负责
					if (fx && fx.src === "turn" && fx.phase !== "done" && fx.phase !== "fade") {
						fx.phase = "done";
						fx.doneAt = now;
					}
				}
			} catch { }
		}

		function paintRows(next, now) {
			try {
				if (typeof document === "undefined") return;
				const snap = statusSnapshot();
				if (snap && !statusKeysSample) {
					const first = snap.values().next().value;
					statusKeysSample = first && typeof first === "object" ? Object.keys(first).join(",") : String(first);
				}
				fxDiag = snap
				? ("status=" + snap.size +
							" running=" + Array.from(snap.values()).filter(function (v) { return v && v.running; }).length +
							" 例键=" + String(Array.from(snap.keys())[0] || "-").slice(0, 24) +
							" 跑=" + (Array.from(snap.entries()).filter(function (e) { return e[1] && e[1].running; }).map(function (e) { return String(e[0]).slice(0, 18); }).join("|") || "-"))
				: ("无状态源 hook=" + (statusHookFound ? "有" : "无") + " 返回=" + statusRawType + " key=" + (turnSid || "空") + " phase=" + next);
				if (statusKeysSample) fxDiag += " 字段=" + statusKeysSample;

				if (fxDiag !== lastDiag) {
					lastDiag = fxDiag;
					const d = new Date();
					const hh = String(d.getHours()).padStart(2, "0");
					const mm = String(d.getMinutes()).padStart(2, "0");
					const ss = String(d.getSeconds()).padStart(2, "0");
					diagLog.push(hh + ":" + mm + ":" + ss + " " + fxDiag);
					if (diagLog.length > 40) diagLog.shift();
				}
				// 预览（演示）期间：只驱动示例行，不碰真实会话
				const previewing = forced && Date.now() < forcedUntil;
				if (previewing) {
					const dfx = fxFor(DEMO_KEY);
					dfx.src = "demo";
					if (dfx.phase !== "think" && dfx.phase !== "stream") dfx.startAt = now;
					dfx.phase = forced;
					dfx.doneAt = 0;
					paintAll(now);
					return;
				}
				// 预览结束：示例行还在就走 done → fade（看得到淡出）；已卸载则直接销毁，避免残留
				if (sessionFx.has(DEMO_KEY)) {
					const dfx = sessionFx.get(DEMO_KEY);
					if (!document.querySelector(".hud-demo")) {
						dropFx(DEMO_KEY);
					} else if (dfx.phase !== "done" && dfx.phase !== "fade") {
						dfx.phase = "done";
						dfx.doneAt = now;
					}
				}

			if (snap) syncFromStatus(snap, now);   // ① 官方状态：覆盖所有会话（多会话）
				syncFromRows(now);                     // ② 侧栏行自身状态：始终可用，含后台会话
			applyCurrentTurn(next, now);            // ③ 当前会话：用本地状态机，响应更快
			paintAll(now);
			} catch { }
		}
			// 抓当前会话的侧栏 key：优先用标题文字匹配，其次才用选中态
			// 抓当前会话：①标题匹配 ②active/selected 属性 ③首条 session 行
			let lastSidSrc = "";
			function captureSid() {
				lastSidSrc = "none";
				try {
					const rows = Array.prototype.slice.call(document.querySelectorAll("[data-row-key]"))
						.filter(function (r) { return rowKeyOf(r); });
					const head = document.querySelector('[data-slot="conversation.session.header"]');
					const headText = ((head && head.textContent) || "").replace(/\s+/g, " ").trim();

					// ① 标题匹配
					if (headText) {
						let best = "", bestLen = 0;
						for (let i = 0; i < rows.length; i++) {
							const text = (rows[i].textContent || "").replace(/\s+/g, " ").trim();
							for (let len = Math.min(text.length, 40); len >= 4; len -= 2) {
								if (headText.indexOf(text.slice(0, len)) >= 0) {
									if (len > bestLen) { best = rowKeyOf(rows[i]); bestLen = len; }
									break;
								}
							}
						}
						if (best) { lastSidSrc = "title"; return best; }
					}

					// ② active / selected / current
					for (let i = 0; i < rows.length; i++) {
						const el = rows[i];
						const cls = String(el.className || "");
						const on = el.getAttribute("aria-selected") === "true" ||
							el.getAttribute("aria-current") === "page" ||
							/(^|[\s_])(selected|active|current)([\s_]|$)/i.test(cls);
						if (on) { lastSidSrc = "attr"; return rowKeyOf(el); }
					}
				} catch { }
				const fallback = rowKeyOf(findTargetRow());
				if (fallback) lastSidSrc = "fallback";
				return fallback;
			}
			// 发送冲击波：从输入框中心扩散一圈
		function sendShock() {
			try {
				const box = document.querySelector('[data-slot="conversation.composer"]');
				if (!box) { pushDiag("冲击波失败: 找不到 composer"); return; }
				// composer 的 slot 包裹层常常是零尺寸，逐级找一个真正有尺寸的元素
				let r = box.getBoundingClientRect();
				if (!(r.width > 40 && r.height > 20)) {
					const inner = box.querySelector('textarea, [contenteditable="true"], input');
					if (inner) {
						const ri = inner.getBoundingClientRect();
						if (ri.width > 40) r = ri;
					}
				}
				if (!(r.width > 40 && r.height > 20)) {
					// 仍然拿不到：退化为视口底部中央
					r = { left: window.innerWidth / 2 - 200, top: window.innerHeight - 150, width: 400, height: 90 };
				}
				const layer = rowFxLayer();
				let el = layer.querySelector(".hud-fx-shock");
				if (!el) {
					el = document.createElement("i");
					el.className = "hud-fx-shock";
					layer.appendChild(el);
				}
				const size = Math.max(r.width, 180);
				el.style.cssText =
					"left:" + (r.left + r.width / 2 - size / 2) + "px;" +
					"top:" + (r.top + r.height / 2 - size / 2) + "px;" +
					"width:" + size + "px;height:" + size + "px;";
				el.classList.remove("on");
				void el.offsetWidth;
				el.classList.add("on");
			} catch { }
		}

		function startTurn(why) {
			sendShock();
			const now = Date.now();
				turn = "pending";
				pendingSince = now;
				turnOut = 0;
				fadeAt = 0;
				powerLevel = 0.05;
				turnSeed = Math.random() * Math.PI * 2;
				turnSid = captureSid();
			if (turnSid) tomb.delete(turnSid);
			// 新一轮开始：清掉上一轮残留的终态元素，避免被守卫挡住
			if (turnSid && sessionFx.has(turnSid)) {
				const oldFx = sessionFx.get(turnSid);
				if (isTerminal(oldFx)) dropFx(turnSid);
			}
				phase = "think";
				phaseEnteredAt = now;
				logEvent("回合开始（" + why + "） sid=" + (turnSid || "空") + " via=" + lastSidSrc);
			pushDiag("startTurn:" + why + " sid=" + ((turnSid || "空").slice(0, 22)));
			}


		function tick() {
			const snap = snapshot();
			let dIn = 0, dOut = 0;
			const now = Date.now();

			if (snap) {
				for (const sid of Object.keys(snap.byId)) {
					const pv = snap.byId[sid] && snap.byId[sid].projectionValues;
					const cur = bucketsOf(pv);
					if (!cur) continue;
					const prev = prevTokens.get(sid);
					if (prev) {
						const di = Math.max(0, (cur.uncachedInputTokens || 0) - (prev.uncachedInputTokens || 0));
						const dO = Math.max(0, (cur.outputTokens || 0) - (prev.outputTokens || 0));
						dIn += di; dOut += dO;
						if (di > 0 || dO > 0) {
						}
					}
					prevTokens.set(sid, cur);
				}
			}

			if (dOut > 0 || dIn > 0) lastActivityAt = now;

			// 吐出 token 时每 250ms 往往有多次突变；思考指示器大约每秒 1 次
			const busy = domPhase() === "active";


			const forcedActive = forced && Date.now() < forcedUntil;
			if (!forcedActive) {
				if (forced) {
					powerLevel = 0;
					const stale = document.querySelectorAll("[data-hud-row]");
					for (let i = 0; i < stale.length; i++) {
						if (!stale[i].getAttribute("data-row-key")) stale[i].setAttribute("data-hud-row", "");
						else stale[i].removeAttribute("data-hud-row");
					}
					notifyTicks(true);
				}
				forced = "";
			}

			// ── 一轮的四个阶段（确定性状态机）─────────────────────────
			// pending    回车后、答案还没开始 → 环绕流光
			// answering  答案在输出           → 进度填充
			// flushing   答案结束、补满停留   → 100% 后淡出
			// idle       空闲
			// 回合开始/结束：以发送按钮的 发送<->停止 翻转为主
			const stopNow = isStopButton(composerSendButton());
			const userCnt = (function () {
				try { return document.querySelectorAll('[data-slot="conversation.user.text.node"]').length; } catch { return -1; }
			})();
			const userAdded = userCnt >= 0 && lastUserCount >= 0 && userCnt > lastUserCount;
			if (userCnt > lastUserCount) lastUserCount = userCnt;


			// 结束信号①：消息尾出现（最可靠，与按钮图标无关）
			try {
				const tc = tailCount();
				if (tc >= 0 && lastTailCount >= 0 && tc > lastTailCount &&
					(turn === "pending" || turn === "answering") && now - pendingSince > 1500) {
					turn = "flushing";
					flushUntil = now + 700;
					logEvent("回合结束（消息尾）");
				}
				if (tc > lastTailCount) lastTailCount = tc;
			} catch { }

			if (stopNow !== null) {
				if (lastStopState !== stopNow) {
					if (stopNow) {
						startTurn("按钮→停止");
					} else if ((turn === "pending" || turn === "answering") && now - pendingSince > 1500) {
						// 1.5 秒宽限：刚发出时按钮还是"发送"形态，不能当成回合结束
						turn = "flushing";
						flushUntil = now + 700;
						logEvent("回合结束（按钮→发送）");
					}
					lastStopState = stopNow;
				}
			} else {
				// 按钮识别不出来：若之前在运行中，视为结束
				if (lastStopState === true && (turn === "pending" || turn === "answering")) {
					turn = "flushing";
					flushUntil = now + 700;
					lastStopState = null;
					logEvent("回合结束（按钮消失）");
				}
			}
			const dAns = answerDelta();
			if (turn === "pending" && now - (apply._dbg || 0) > 3000) {
				apply._dbg = now;
			}
			const answerStarted = (dAns >= 4 && now - pendingSince > 2500) || dOut > 0;
			if (answerStarted && turn === "pending") {
				logEvent("答案开始 dAns=" + dAns + " 距发送" + (now - pendingSince) + "ms dOut=" + dOut);
				try {
					const names2 = [];
					document.querySelectorAll("[data-slot]").forEach((el) => {
						const v = el.getAttribute("data-slot") || "";
						if (v.indexOf("conversation") < 0 && v.indexOf("chat") < 0) return;
						if (names2.indexOf(v) < 0 && names2.length < 30) names2.push(v);
					});
					logEvent("slots@开始 " + names2.join(","));
				} catch { }
			}

			// 一轮结束：turnTail（消息尾）出现即视为完成
			let tails = -1;
			try { tails = document.querySelectorAll('[data-slot="conversation.chat.turnTail"]').length; } catch { }
			const tailAdded = tails >= 0 && lastTailCount >= 0 && tails > lastTailCount;
			if (tails >= 0 && tails > lastTailCount) lastTailCount = tails;

			if (turn === "pending") {
				// 环固定播 3 秒，然后进入输出态（不依赖任何文本测量）
				if (now - pendingSince > 5000) {
					turn = "answering";
					phaseEnteredAt = now;
					logEvent("5 秒到 → 进入输出态");
				} else if (now - pendingSince > 90000) {
					turn = "idle";
				}
			} else if (turn === "answering") {
				// 结束完全交给发送按钮（回合结束已在上方处理），这里不再自行判断
				if (now - pendingSince > 180000) turn = "idle";   // 极端兜底：3 分钟
			} else if (turn === "flushing") {
				if (now > flushUntil) turn = "idle";
			} else if (turn === "idle" && now - lastTypingAt < 1600) {
				turn = "typing";
			} else if (turn === "typing" && now - lastTypingAt > 1600) {
				turn = "idle";
			}

			let next = "idle";
			if (turn === "pending") next = "think";
			else if (turn === "answering") next = "stream";
			else if (turn === "flushing") next = "done";
			else if (turn === "typing") next = "typing";

			if (forcedActive) next = forced;

			// 预览期间若存在选中的会话行，也让它同步演示
			if (forcedActive && (next === "think" || next === "stream")) {
				const sidP = selectedSessionId();
				if (sidP) {
				}
			}

			// 当前会话行：跟随全局状态。预览期间不碰真实行（只在示例条上演示）
			const activeSid = selectedSessionId();
			if (forcedActive) {
				/* 预览：保持行状态，由上面统一的预览分支设置 */
			} else {
				if (next !== "idle" && activeSid) {
				}
				if (next === "stream") {
					turnOut += dOut;
					const dtSec = Math.max(0, (now - pendingSince - 5000) / 1000);
					// 渐近曲线：一直缓慢前进，永远到不了 0.92，避免"卡死"观感
					let pv = 0.92 * (1 - Math.exp(-dtSec / 34));
					pv += 0.010 * Math.sin(now / 620 + turnSeed);   // 轻微呼吸，节奏不呆板
					powerLevel = Math.min(0.93, Math.max(0.05, pv));
				} else if (next === "done") {
					powerLevel = 1;
				} else if (next === "idle" || next === "typing") {
					if (!fadeAt) fadeAt = now;
					if (now - fadeAt > 1500) { powerLevel = 0; turnOut = 0; }
				} else {
					powerLevel = Math.max(0, powerLevel - 0.12);
				}
				if (next !== "idle" && next !== "typing") fadeAt = 0;
			}

			if (next !== phase) {
				phaseEnteredAt = now;
				phase = next;
			}


			applyVisualState();
			paintRows(next, now);
			updateBadge();
			notifyTicks();
		}

		// ── 打字涟漪 ────────────────────────────────────────────────
		function isEditable(el) {
			if (!el) return false;
			const tag = el.tagName;
			return tag === "TEXTAREA" || tag === "INPUT" || el.isContentEditable;
		}

		// 涟漪画在独立的 fixed 图层上，用视口坐标，不依赖宿主的定位上下文
		function fxLayer() {
			let el = document.getElementById("dsh-hud-fx");
			if (el) return el;
			el = document.createElement("div");
			el.id = "dsh-hud-fx";
			el.setAttribute("aria-hidden", "true");
			document.body.appendChild(el);
			return el;
		}

		// 演示条内部的涟漪（不受底层图层遮挡）
		function rippleInside(host) {
			if (!host || !host.appendChild) return;
			const r = host.getBoundingClientRect();
			if (!r.width || !r.height) return;
			const edge = Math.floor(Math.random() * 4);
			let x, y;
			if (edge === 0) { x = 10 + Math.random() * (r.width - 20); y = 1; }
			else if (edge === 2) { x = 10 + Math.random() * (r.width - 20); y = r.height - 1; }
			else if (edge === 1) { x = r.width - 1; y = 6 + Math.random() * (r.height - 12); }
			else { x = 1; y = 6 + Math.random() * (r.height - 12); }
			const dot = document.createElement("span");
			dot.className = "hud-ripple-local";
			dot.style.left = Math.round(x) + "px";
			dot.style.top = Math.round(y) + "px";
			host.appendChild(dot);
			setTimeout(() => { try { dot.remove(); } catch { } }, 820);
		}

		let rectCache = { box: null, r: null, at: 0 };

		function spawnRipple(target) {
			const box = glowTarget(target) || target;
			if (!box || !box.getBoundingClientRect) return;
			try {
				const now = Date.now();
				let r;
				if (rectCache.box === box && now - rectCache.at < 800) {
					r = rectCache.r;
				} else {
					r = box.getBoundingClientRect();
					rectCache = { box, r, at: now };
				}
				if (!r.width || !r.height) return;
				const layer = fxLayer();
				const edge = Math.floor(Math.random() * 4);
				let x, y;
				if (edge === 0) { x = r.left + 10 + Math.random() * (r.width - 20); y = r.top; }
				else if (edge === 2) { x = r.left + 10 + Math.random() * (r.width - 20); y = r.bottom; }
				else if (edge === 1) { x = r.right; y = r.top + 6 + Math.random() * (r.height - 12); }
				else { x = r.left; y = r.top + 6 + Math.random() * (r.height - 12); }
				const dot = document.createElement("span");
				dot.className = "hud-ripple";
				dot.style.position = "fixed";
				dot.style.left = Math.round(x) + "px";
				dot.style.top = Math.round(y) + "px";
				layer.appendChild(dot);
				setTimeout(() => { try { dot.remove(); } catch { } }, 760);
			} catch { }
		}

		// 从焦点元素往上找"带圆角的容器"，也就是输入框的外壳
		const glowCache = new WeakMap();

		function glowTarget(el) {
			if (!el) return null;
			if (glowCache.has(el)) return glowCache.get(el);
			let node = el.parentElement, found = null;
			for (let i = 0; i < 7 && node && node !== document.body; i++) {
				let radius = "0px";
				try { radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0; } catch { }
				if (radius >= 6) { found = node; break; }
				node = node.parentElement;
			}
			const result = found || (el.parentElement || null);
			glowCache.set(el, result);
			return result;
		}

		let glowNode = null;
		function pulseGlow(el) {
			const target = glowTarget(el);
			if (!target) return;
			if (glowNode && glowNode !== target) {
				try { glowNode.classList.remove("hud-glow"); } catch { }
			}
			glowNode = target;
			try { target.classList.add("hud-glow"); } catch { }
			clearTimeout(pulseGlow._t);
			pulseGlow._t = setTimeout(() => {
				try { target.classList.remove("hud-glow"); } catch { }
			}, 160);
		}

		function onKeyDown(e) {
			if (!isEditable(e.target)) return;
			pulseGlow(e.target);
			if (e.key === "Enter" && !e.shiftKey) {
				pushDiag("触发: 回车");
			// 发送：统一走 startTurn（含会话锁定）
			lastTypingAt = 0;
			startTurn("回车");
				try {
					const names = [];
					document.querySelectorAll("[data-slot]").forEach((el) => {
						const v = el.getAttribute("data-slot") || "";
						if (v.indexOf("conversation") < 0 && v.indexOf("chat") < 0) return;
						if (names.indexOf(v) < 0 && names.length < 30) names.push(v);
					});
					logEvent("slots " + names.join(","));
				} catch { }
				phase = "think";
				phaseEnteredAt = Date.now();
				applyVisualState();
				notifyTicks(true);
				return;
			}
			lastTypingAt = Date.now();

		}

		// 输入法组合输入不会走 keydown，这里补一条 input 监听
		function onInput(e) {
			if (!isEditable(e.target)) return;
			lastTypingAt = Date.now();
			pulseGlow(e.target);

		}

		// ── 样式 ────────────────────────────────────────────────────
		function ensureCss() {
			try {
				if (typeof document === "undefined" || !document.head) return;
				let style = document.getElementById("dsh-hud-css");
				if (!style) {
					style = document.createElement("style");
					style.id = "dsh-hud-css";
					document.head.appendChild(style);
				}
				style.textContent = `
@property --hud-h { syntax: "<number>"; inherits: true; initial-value: 188; }
:root { --hud-h: 188; --hud-strength: .8; }
html { transition: --hud-h var(--hud-hue-dur, .55s) cubic-bezier(.3,.7,.4,1); }

/* 背景层：整窗一层，不参与宿主布局 */
#dsh-hud-root {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  overflow: hidden; contain: strict;
}
#dsh-hud-root .hud-plasma {
  position: absolute; inset: -18%;
  opacity: calc(.55 * var(--hud-strength));
  transition: opacity .9s ease;
}
#dsh-hud-root .hud-plasma::before {
  content: ""; position: absolute; inset: 0;
  background:
    radial-gradient(42% 38% at 24% 28%, hsl(196 88% 56% / .30), transparent 72%),
    radial-gradient(38% 42% at 78% 62%, hsl(214 86% 52% / .22), transparent 72%),
    radial-gradient(52% 34% at 52% 94%, hsl(178 84% 46% / .18), transparent 74%);
  animation: hudDrift 26s ease-in-out infinite alternate;
}
.hud-demo {
  position: relative; height: 36px; margin-top: 6px; border-radius: 8px;
  display: flex; align-items: center; padding: 0 10px; overflow: hidden;
  background: color-mix(in srgb, currentColor 9%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
#dsh-hud-rowfx {
  position: fixed; inset: 0; z-index: 9000; pointer-events: none; overflow: hidden;
}
#dsh-hud-rowfx .hud-fx-ring {
  position: absolute; display: block; border-radius: 10px; padding: 2px;
  opacity: 0; transition: opacity .3s ease;
  background: conic-gradient(from var(--hud-angle),
    hsl(var(--hud-h) 95% 70% / .12) 0 26%,
    hsl(var(--hud-h) 96% 74% / .38) 50%,
    hsl(var(--hud-h) 98% 80% / .62) 66%,
    hsl(var(--hud-h) 98% 84% / .70) 76%,
    hsl(var(--hud-h) 96% 74% / .38) 90%,
    hsl(var(--hud-h) 95% 70% / .12) 100%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  filter: drop-shadow(0 0 5px hsl(var(--hud-h) 95% 68% / .7));
  animation: hudSpin var(--hud-ring-spin, 1.45s) linear infinite;
}
#dsh-hud-rowfx .hud-fx-bar {
			position: absolute; display: block; border-radius: 4px;
			opacity: 0; transition: opacity .6s ease, width .22s linear;
			background: linear-gradient(90deg,
				hsl(var(--hud-h) 95% 58% / .10),
				hsl(var(--hud-h) 96% 66% / .34));
			border-bottom: 2px solid hsl(var(--hud-h) 98% 76% / .95);
			box-shadow: 0 0 10px hsl(var(--hud-h) 95% 66% / .55);
}
#dsh-hud-rowfx .hud-fx-ring2 {
  position: absolute; display: block; border-radius: 10px; padding: 1.5px;
  opacity: 0; transition: opacity .3s ease;
  background: conic-gradient(from calc(var(--hud-angle) * -1),
    transparent 0 62%, hsl(calc(var(--hud-h) + 28) 96% 72% / .85) 78%, transparent 92%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  filter: drop-shadow(0 0 4px hsl(calc(var(--hud-h) + 28) 96% 70% / .6));
  animation: hudSpinRev calc(var(--hud-ring-spin, 1.45s) * 1.7) linear infinite;
}
@keyframes hudSpinRev { to { --hud-angle: -360deg; } }
#dsh-hud-rowfx .hud-fx-bar {
  position: absolute; display: block; border-radius: 3px; overflow: hidden;
  opacity: 0; transition: opacity var(--hud-fade, 1.35s) cubic-bezier(.4,0,.6,1), width .28s linear;
  background-image: linear-gradient(90deg,
    hsl(var(--hud-h) 95% 56% / .20),
    hsl(var(--hud-h) 97% 68% / .42),
    hsl(var(--hud-h) 99% 78% / .58));
  border-bottom: var(--hud-edge-w, 1.5px) solid hsl(var(--hud-h) 98% 80% / var(--hud-edge-a, .45));
  box-shadow: 0 0 14px hsl(var(--hud-h) 95% 66% / .45);
  animation: hudBarBreath var(--hud-breath, 1.9s) ease-in-out infinite;
}
@keyframes hudBarBreath {
  0%, 100% { filter: brightness(.90) saturate(1); }
  50%      { filter: brightness(1.32) saturate(1.15); }
}
#dsh-hud-rowfx .hud-fx-bar[data-done="1"] {
  background-image: linear-gradient(90deg,
    hsl(var(--hud-h) 96% 66% / .55),
    hsl(var(--hud-h) 99% 84% / .90));
  animation: hudBarBreath calc(var(--hud-breath, 1.9s) * 0.58) ease-in-out infinite;
}
#dsh-hud-rowfx .hud-fx-bar::after {
  content: ""; position: absolute; inset: 0; opacity: 0; pointer-events: none;
  background: linear-gradient(90deg,
    transparent 0 30%, rgba(255,255,255,.55) 42%,
    rgba(255,255,255,.98) 50%, rgba(255,255,255,.55) 58%, transparent 70%);
  transform: translateX(-100%);
}
#dsh-hud-rowfx .hud-fx-bar[data-done="1"]::after { animation: hudBarSweep .75s ease-out 1; }
@keyframes hudBarSweep {
  0%   { opacity: 0; transform: translateX(-110%); }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { opacity: 0; transform: translateX(110%); }
}
#dsh-hud-rowfx .hud-fx-rowsweep {
  position: absolute; display: block; pointer-events: none; opacity: 0;
  border-radius: 9px; overflow: hidden;
  background-image: linear-gradient(100deg,
    transparent 0 34%,
    hsl(var(--hud-h) 96% 78% / .22) 44%,
    hsl(var(--hud-h) 99% 94% / .48) 50%,
    hsl(var(--hud-h) 96% 78% / .22) 56%,
    transparent 66% 100%);
  background-size: 55% 100%;
  background-repeat: no-repeat;
  background-position: -60% 0;
}
#dsh-hud-rowfx .hud-fx-rowsweep.on { animation: hudRowSweep .7s ease-out 1; }
@keyframes hudRowSweep {
  0%   { opacity: 0; background-position: -60% 0; }
  18%  { opacity: 1; }
  82%  { opacity: 1; }
  100% { opacity: 0; background-position: 160% 0; }
}
#dsh-hud-rowfx .hud-fx-glow {
  position: absolute; display: block; border-radius: 10px; pointer-events: none;
  opacity: 0; transition: opacity .45s ease;
  box-shadow: 0 0 18px 2px hsl(var(--hud-h) 96% 62% / .20),
              inset 0 0 12px hsl(var(--hud-h) 96% 68% / .12);
  animation: hudGlowBreath 2.6s ease-in-out infinite;
}
@keyframes hudGlowBreath {
  0%, 100% { filter: brightness(.85); }
  50%      { filter: brightness(1.25); }
}
#dsh-hud-rowfx .hud-fx-shock {
  position: absolute; display: block; pointer-events: none; opacity: 0;
  border-radius: 50%;
  border: 2.5px solid hsl(var(--hud-h) 98% 80% / .85);
  box-shadow: 0 0 28px hsl(var(--hud-h) 96% 70% / .55),
              inset 0 0 24px hsl(var(--hud-h) 96% 72% / .30);
  transform: scale(.18);
}
#dsh-hud-rowfx .hud-fx-shock.on { animation: hudShock .75s cubic-bezier(.2,.8,.3,1) 1; }
@keyframes hudShock {
  0%   { opacity: .95; transform: scale(.18); border-width: 3.5px; }
  55%  { opacity: .55; }
  100% { opacity: 0;   transform: scale(1.15); border-width: 1px; }
}
#dsh-hud-rowfx .hud-fx-hover {
  position: absolute; display: block; pointer-events: none; opacity: 0;
  border-radius: 9px; overflow: hidden;
  background-image: linear-gradient(180deg,
    transparent 0 42%,
    hsl(var(--hud-h) 96% 80% / .30) 48%,
    hsl(var(--hud-h) 99% 94% / .55) 50%,
    hsl(var(--hud-h) 96% 80% / .30) 52%,
    transparent 58% 100%);
  background-size: 100% 50%;
  background-repeat: no-repeat;
  background-position: 0 -60%;
}
#dsh-hud-rowfx .hud-fx-hover.on { animation: hudHoverSweep .62s ease-out 1; }
@keyframes hudHoverSweep {
  0%   { opacity: 0; background-position: 0 -60%; }
  18%  { opacity: 1; }
  82%  { opacity: 1; }
  100% { opacity: 0; background-position: 0 160%; }
}
#dsh-hud-root .hud-rain {
  position: absolute; inset: 0; width: 100%; height: 100%;
  opacity: calc(.95 * var(--hud-strength));
  transition: opacity .6s ease;
}
#dsh-hud-root .hud-scan {
  position: absolute; inset: 0; opacity: .22;
  background: repeating-linear-gradient(0deg, rgba(255,255,255,.05) 0 1px, transparent 1px 3px);
}
#dsh-hud-root .hud-scrim {
  position: absolute; inset: 0;
  background: radial-gradient(120% 100% at 50% 0%, rgba(6,10,16,.18), rgba(4,7,11,.42) 70%, rgba(3,5,8,.60));
}
#dsh-hud-root .hud-vignette {
  position: absolute; inset: 0;
  background: radial-gradient(115% 88% at 50% 46%, transparent 52%, rgba(0,0,0,.62));
}

/* 接管宿主的底色：整窗只留我们这一层。
   逐个元素覆盖不可靠（对话视图内部还有自己的不透明底），
   所以直接把主题的背景 token 改成半透明，让 HUD 透出来。 */
body {
  --dsw-alias-bg-base: rgba(6, 9, 13, .40) !important;
  --dsw-alias-bg-layer-1: rgba(8, 12, 18, .40) !important;
  --dsw-alias-bg-layer-2: rgba(10, 14, 20, .40) !important;
  --dsw-alias-bg-layer-3: rgba(12, 16, 22, .40) !important;
  --dsw-specific-sidebar-fill: rgba(6, 9, 13, .28) !important;
}
#root,
[data-slot="main"],
[data-slot="main.conversation"],
[data-slot="conversation.view"],
[data-slot="sidebar"] { background: transparent !important; }
[class*="frame"] { background: transparent !important; }
[class*="sidebarCol"], [class*="centerCol"], [class*="rightbarCol"] { background: transparent !important; }
[class*="sidebarCol"], [class*="centerCol"], [class*="rightbarCol"] { background: transparent !important; }

@property --hud-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }

/* 会话行：::after 是环绕充能（思考），::before 是横向充能（输出）。
   两个伪元素常驻、只切换透明度，所以切换时有约 0.25s 的过渡交集。 */
[data-row-key] { position: relative; }

/* 思考时隐藏宿主自带的圆形进度 */
[data-row-key] [class*="slot"] > svg { opacity: 0 !important; }
body[data-hud-state="think"] .hud-charge i { opacity: .75; animation-duration: 2.2s; }
body[data-hud-state="stream"] .hud-charge i { opacity: 1; animation-duration: .8s; }

/* 打字反馈 */
.hud-ripple-local {
  position: absolute; width: 6px; height: 6px; margin: -3px 0 0 -3px;
  border-radius: 50%; pointer-events: none;
  background: hsl(var(--hud-h) 95% 70% / .9);
  box-shadow: 0 0 10px hsl(var(--hud-h) 95% 70% / .8);
  animation: hudRipple .8s ease-out forwards;
}
.hud-ripple {
  position: fixed; width: 6px; height: 6px; margin-left: -3px; margin-top: -3px;
  border-radius: 50%; pointer-events: none;
  background: hsl(var(--hud-h) 95% 70% / .9);
  box-shadow: 0 0 10px hsl(var(--hud-h) 95% 70% / .8);
  animation: hudRipple .7s ease-out forwards;
}
.hud-glow {
  box-shadow: 0 0 0 1px hsl(var(--hud-h) 92% 64% / .55),
              0 0 22px hsl(var(--hud-h) 92% 64% / .22) !important;
  transition: box-shadow .18s ease !important;
}

@keyframes hudDrift {
  0%   { transform: translate3d(-2%, -1%, 0) scale(1.02); }
  50%  { transform: translate3d(2%, 1.5%, 0) scale(1.06); }
  100% { transform: translate3d(-1%, 2%, 0) scale(1.03); }
}
@keyframes hudSpin { to { --hud-angle: 360deg; } }
@keyframes hudSweep {
  from { background-position: -42% 0; }
  to   { background-position: 100% 0; }
}
@keyframes hudFlow {
  0%   { background-position: 220% 0; }
  100% { background-position: -220% 0; }
}
@keyframes hudRipple {
  0%   { transform: scale(.5); opacity: .95; }
  100% { transform: scale(7); opacity: 0; }
}
@keyframes hudBurst {
  0%   { opacity: 1; }
  100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  #dsh-hud-root .hud-plasma::before, [data-row-key]::after, .hud-charge i { animation: none !important; }
}
`;
				document.head.appendChild(style);
			} catch { }
		}

		// ── 座位：会话行 ────────────────────────────────────────────
		function RowSeat() {
			// 会话行上色改由 paintRows 直接操作 DOM，这里只保留座位以维持注册关系
			return null;
		}

		// ── 座位：输入框上方充能条 ──────────────────────────────────
		function ChargeBar() {
			if (!settings.bar) return null;
			return h("div", { className: "hud-charge", "aria-hidden": "true" },
				h("i", null));
		}

		// ── 座位：侧栏图标 ──────────────────────────────────────────
		function HudIcon(props) {
			captureStatusHook(props);
			return h("svg", {
				width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
				strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				h("path", { d: "M4 15.5 8.5 6l3 6 2.5-4 2 5" }),
				h("path", { d: "M3.5 19.5h17" }),
				h("circle", { cx: 18.2, cy: 7.2, r: 1.3 }));
		}

		// 背景预览：直接复用 drawScene，和正式环境同一套绘制
		function BgPreview() {
			const ref = React.useRef(null);
			React.useEffect(() => {
				const cvs = ref.current;
				if (!cvs) return;
				const c = cvs.getContext("2d");
				if (!c) return;
				const dpr = Math.min(2, window.devicePixelRatio || 1);
				const w = cvs.clientWidth || 260;
				const h = 110;
				cvs.width = Math.round(w * dpr);
				cvs.height = Math.round(h * dpr);
				c.setTransform(dpr, 0, 0, dpr, 0, 0);

				const cols = [];
				const n = Math.max(8, Math.ceil(w / 20));
				for (let i = 0; i < n; i++) {
					cols.push({
						x: i * 20 + 4,
						y: Math.random() * h,
						speed: 18 + Math.random() * 34,
						len: 6 + ((Math.random() * 8) | 0),
						accent: i % 3 === 0,
					});
				}
				const ptc = [];
				for (let i = 0; i < 26; i++) {
					ptc.push({
						x: Math.random() * w, y: Math.random() * h,
						r: 1 + Math.random() * 1.2,
						vy: -(3 + Math.random() * 10), vx: (Math.random() - 0.5) * 4,
						a: 0.18 + Math.random() * 0.30,
						bright: Math.random() < 0.25,
					});
				}

				let raf = 0, last = 0;
				const loop = (t) => {
					raf = requestAnimationFrame(loop);
					if (t - last < 50) return;
					const dt = Math.min(0.2, (t - last) / 1000 || 0.016);
					last = t;
					for (const cc of cols) {
						cc.y += cc.speed * dt * 1.4;
						if (cc.y - cc.len * 14 > h) cc.y = -Math.random() * 80;
					}
					const strength = 0.35 + (settings.intensity / 100) * 0.65;
					const hue = (phase === "typing" || phase === "think" || phase === "stream")
						? (HUE[phase] || BASE_HUE) : BASE_HUE;
					drawScene(c, w, h, dt * 1.4, cols, ptc, hue, strength, true);
				};
				raf = requestAnimationFrame(loop);
				return () => { try { cancelAnimationFrame(raf); } catch { } };
			}, []);
			return h("canvas", {
				ref,
				style: {
					width: "100%", height: 110, display: "block", borderRadius: 8,
					background: "#05080c",
					border: "1px solid color-mix(in srgb, currentColor 12%, transparent)",
				},
			});
		}

		// ── 座位：设置面板 ──────────────────────────────────────────
		function HudPanel(props) {
			captureStatusHook(props);
			const [cfg, setCfg] = React.useState(settings);
			const [tickCount, setTickCount] = React.useState(0);
			const [active, setActive] = React.useState("");

			const update = (patch) => {
				setTimeout(() => { try { applyTiming(); } catch { } }, 0);
				const next = Object.assign({}, cfg, patch);
				setCfg(next);
				settings = next;
				writeSettings(next);
				applyVisualState();
			};

			React.useEffect(() => {
				const t = setInterval(() => setTickCount((n) => n + 1), 800);
				return () => clearInterval(t);
			}, []);

			const row = (label, control, hint) => h("div", { style: S.row },
				h("div", { style: S.label }, label),
				h("div", { style: { display: "flex", alignItems: "center", gap: 10 } }, control),
				hint ? h("div", { style: S.hint }, hint) : null);

			const toggle = (key, label) => h("label", { style: S.switch },
				h("input", {
					type: "checkbox", checked: !!cfg[key],
					onChange: (e) => update({ [key]: e.target.checked }),
					style: { marginRight: 8 },
				}),
				label);

			const forcedPhase = forced ? forced : "";
			const stateLabel = phase === "stream" ? "输出中" : phase === "think" ? "思考中" : phase === "typing" ? "输入中" : "空闲";
			const activeLabel = (k) => k;
			const previewBtn = (key, label) => h("button", {
				style: Object.assign({}, S.btn, active === key ? {
					background: "hsl(" + HUE[key] + " 90% 60% / .28)",
					borderColor: "hsl(" + HUE[key] + " 90% 65% / .9)",
					fontWeight: 600,
				} : {}),
				onClick: () => {
					forceState(key, 6000);
					setActive(key);
					setTimeout(() => setActive(""), 6000);
					if (key === "typing") {
						const box = document.querySelector(".hud-demo");
						if (box) {
							let n = 0;
							const timer = setInterval(() => {
								if (n++ > 16) { clearInterval(timer); return; }
								box.classList.add("hud-glow");
								setTimeout(() => { try { box.classList.remove("hud-glow"); } catch { } }, 150);
							}, 220);
							setTimeout(() => clearInterval(timer), 3600);
						}
					}
				},
			}, label);
			const hueName = phase === "stream" ? "橙" : phase === "think" ? "紫" : phase === "typing" ? "青" : "灰蓝";

			return h("div", { style: S.wrap },
				h("div", { style: S.head },
					h("span", { style: S.title }, "HUD"),
					h("div", { style: { flex: 1 } }),
					h("span", { style: S.state }, stateLabel + " · " + hueName)),

				h("div", { style: S.card },
					h("div", { style: { display: "flex", gap: 22, alignItems: "flex-start", flexWrap: "wrap" } },

					h("div", { style: { flex: "1 1 260px", minWidth: 240 } },
					row("强度", h("input", {
						type: "range", min: 0, max: 100, value: cfg.intensity,
						onChange: (e) => update({ intensity: Number(e.target.value) }),
						style: { flex: 1 },
					}), cfg.intensity + "%"),

					h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px 18px", marginTop: 4 } },
						toggle("plasma", "能量场"),
						toggle("rain", "数据流"),
						toggle("rows", "会话行流光"),
						toggle("ring2", "副环"),
						toggle("particles", "粒子"),
						toggle("grid", "网格"),
						toggle("bar", "充能条")),

					h("div", { style: { marginTop: 14, paddingTop: 12, borderTop: "1px solid color-mix(in srgb, currentColor 10%, transparent)" } },
						h("div", { style: { fontSize: 12, opacity: .75, marginBottom: 8 } }, "动效时序"),
						row("呼吸", h("input", {
							type: "range", min: 8, max: 40, step: 1, value: Math.round((cfg.breath || 1.9) * 10),
							onChange: (e) => update({ breath: Number(e.target.value) / 10 }),
							style: { flex: 1 },
						}), (cfg.breath || 1.9).toFixed(1) + "s"),
						row("环速", h("input", {
							type: "range", min: 6, max: 30, step: 1, value: Math.round((cfg.ringSpin || 1.45) * 10),
							onChange: (e) => update({ ringSpin: Number(e.target.value) / 10 }),
							style: { flex: 1 },
						}), (cfg.ringSpin || 1.45).toFixed(1) + "s"),
						row("停留", h("input", {
							type: "range", min: 200, max: 2000, step: 100, value: cfg.hold || 900,
							onChange: (e) => update({ hold: Number(e.target.value) }),
							style: { flex: 1 },
						}), (cfg.hold || 900) + "ms"),
						row("淡出", h("input", {
							type: "range", min: 300, max: 2500, step: 50, value: cfg.fade || 1350,
							onChange: (e) => update({ fade: Number(e.target.value) }),
							style: { flex: 1 },
						}), (cfg.fade || 1350) + "ms"),
						row("变色", h("input", {
							type: "range", min: 10, max: 150, step: 5, value: Math.round((cfg.hueDur || 0.55) * 100),
							onChange: (e) => update({ hueDur: Number(e.target.value) / 100 }),
							style: { flex: 1 },
						}), (cfg.hueDur || 0.55).toFixed(2) + "s"),
						row("底边", h("input", {
							type: "range", min: 0, max: 100, step: 5, value: (cfg.edge === undefined ? 45 : cfg.edge),
							onChange: (e) => update({ edge: Number(e.target.value) }),
							style: { flex: 1 },
						}), (cfg.edge === undefined ? 45 : cfg.edge) === 0 ? "关" : ((cfg.edge === undefined ? 45 : cfg.edge) + "%"))),


					),
					h("div", { style: { flex: "1 1 240px", minWidth: 220 } },
					h("div", { style: { marginTop: 16, paddingTop: 14, borderTop: "1px solid color-mix(in srgb, currentColor 10%, transparent)" } },
						h("div", { style: { fontSize: 12, opacity: .75, marginBottom: 8 } }, "预览"),
						h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
							previewBtn("typing", "打字"),
							previewBtn("think", "思考"),
							previewBtn("stream", "输出")),
						h("div", { style: { fontSize: 11, marginTop: 8, opacity: .55 } },
							active ? ("预览中·6 秒后自动恢复") : "未在预览"),
						h("label", {
							style: { display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 11, opacity: .6, cursor: "pointer" },
						},
							h("input", {
								type: "checkbox", checked: !!cfg.debug,
								onChange: (e) => update({ debug: e.target.checked }),
							}),
							"显示调试信息"),
						cfg.debug && h("div", { style: { marginTop: 8 } },
						h("div", {
							style: { fontSize: 10, marginTop: 8, opacity: .6, fontFamily: "ui-monospace, monospace" },
						}, "build " + HUD_BUILD + " · 诊断: " + fxDiag),
						h("pre", {
							style: {
								fontSize: 10, marginTop: 6, opacity: .55, lineHeight: 1.55,
								whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace",
								maxHeight: 120, overflow: "auto",
							},
						}, diagLog.slice(-10).join("\n") || "（暂无诊断记录）"),
						h("pre", {
							style: {
								fontSize: 10, marginTop: 8, opacity: .5, lineHeight: 1.6,
								whiteSpace: "pre-wrap", fontFamily: "ui-monospace, monospace",
							},
						}, events.slice(-8).join("\n") || "（暂无状态记录）"),
						h("div", { style: { fontSize: 10, marginTop: 6, opacity: .38, fontVariantNumeric: "tabular-nums" } },
							"实时：" + phase +
							" · 功率 " + powerLevel.toFixed(2) +
							" · 目标 " + (rowFindMode || "未找到") +
							" · 目标 " + (rowFindMode || "-")),
						),
						h("div", { style: { marginTop: 12, fontSize: 11, opacity: .45 } }, "背景 + 会话行"),
						h("div", { style: { position: "relative", marginTop: 6 } },
							h(BgPreview),
							h("div", {
								className: "hud-demo",
								style: {
									position: "absolute", left: 14, right: 14, top: "50%",
									transform: "translateY(-50%)", marginTop: 0,
									background: "color-mix(in srgb, #000 55%, transparent)",
									backdropFilter: "blur(1px)",
								},
							},
								h("span", { style: { position: "relative", zIndex: 2, fontSize: 12, opacity: .9 } },
									"示例会话 · " + (forcedPhase || "未预览"))))),
					h("div", { style: { display: "flex", gap: 8, marginTop: 10 } },
						h("button", {
							style: S.btn,
							onClick: () => {
								settings = Object.assign({}, DEFAULTS);
								setCfg(settings);
								writeSettings(settings);
								applyVisualState();
							},
						}, "恢复默认"),
						h("button", {
							style: S.btn,
							onClick: () => {
								const root = document.documentElement;
								root.style.setProperty("--hud-h", String(HUE[phase] || HUE.idle));
							},
						}, "重新同步配色"))))));
		}

		const S = {
			wrap: { maxHeight: "calc(100vh - 40px)", overflowY: "auto", padding: "28px 32px 40px", maxWidth: 720, margin: "0 auto", color: "inherit" },
			head: { display: "flex", alignItems: "center", marginBottom: 16 },
			title: { fontSize: 14, fontWeight: 600, letterSpacing: .2, opacity: .9 },
			state: { fontSize: 11, opacity: .55, fontVariantNumeric: "tabular-nums" },
			card: {
				border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
				background: "color-mix(in srgb, currentColor 4%, transparent)",
				borderRadius: 14, padding: "18px 20px",
			},
			row: { marginBottom: 14 },
			label: { fontSize: 12, opacity: .75, marginBottom: 6 },
			hint: { fontSize: 11, opacity: .45, marginTop: 4 },
			hint2: { fontSize: 11, opacity: .45, marginTop: 12, lineHeight: 1.7 },
			input: {
				width: 90, padding: "5px 8px", borderRadius: 7, fontSize: 12, color: "inherit",
				border: "1px solid color-mix(in srgb, currentColor 20%, transparent)",
				background: "color-mix(in srgb, currentColor 6%, transparent)",
			},
			btn: {
				border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
				background: "color-mix(in srgb, currentColor 6%, transparent)",
				color: "inherit", borderRadius: 8, padding: "5px 12px", fontSize: 12, cursor: "pointer",
			},
			switch: { display: "inline-flex", alignItems: "center", fontSize: 12, opacity: .8, cursor: "pointer" },
		};

		// ── 启动 ────────────────────────────────────────────────────
		function startBackground() {
			ensureCss();
			const root = ensureRoot();
			if (!root) return;
			canvas = root.querySelector("canvas.hud-rain");
			if (canvas) resizeCanvas();
			window.addEventListener("resize", resizeCanvas);
			if (!rafId) rafId = requestAnimationFrame(frameLoop);
		}

		const inject = ["slots"];

		function apply(ctx) {
			// 清理上一次加载留下的图层，避免重载后残留"半路"的进度条
			try {
				const old = document.getElementById("dsh-hud-rowfx");
				if (old && old.parentNode) old.parentNode.removeChild(old);
			} catch { }
			pluginCtx = ctx;

			// 热更新会重复执行 apply：先把上一轮的监听器/定时器全部拆掉，
			// 否则每改一次代码就多一套（涟漪残留、越用越卡都是这个原因）。
			try {
				const prev = window.__dshHudRuntime;
				if (prev && typeof prev.dispose === "function") prev.dispose();
			} catch { }

			startBackground();
			document.addEventListener("keydown", onKeyDown, true);
			document.addEventListener("input", onInput, true);
			document.addEventListener("click", onClickPickRow, true);

		// 点击输入框里的发送按钮 = 明确的一次发送（不依赖按钮图标识别）
			const onComposerClick = (e) => {
			try {
				const box = document.querySelector('[data-slot="conversation.composer"]');
				if (!box || !box.contains(e.target)) return;
				const btn = e.target.closest && e.target.closest("button");
				if (!btn) return;
				const btns = box.querySelectorAll("button");
				if (btns.length && btn !== btns[btns.length - 1]) return;   // 只认最后一个（发送/停止）
				pushDiag("触发: 点击发送");
				startTurn("点击发送");
			} catch { }
		};
		document.addEventListener("click", onComposerClick, true);
	document.addEventListener("pointerover", onPointerOver, true);

			tick();
			const interval = setInterval(tick, 250);

			window.__dshHudRuntime = {
				dispose() {
					try { document.removeEventListener("keydown", onKeyDown, true); } catch { }
					try { document.removeEventListener("input", onInput, true); } catch { }
					try { document.removeEventListener("click", onClickPickRow, true); } catch { }
			try { document.removeEventListener("pointerover", onPointerOver, true); } catch { }
					try { window.removeEventListener("resize", resizeCanvas); } catch { }
					try { clearInterval(interval); } catch { }
					try { if (rafId) cancelAnimationFrame(rafId); rafId = 0; } catch { }
					try { if (flowObserver) flowObserver.disconnect(); } catch { }
					try { const el = document.getElementById("dsh-hud-root"); if (el) el.remove(); } catch { }
					try { const el = document.getElementById("dsh-hud-fx"); if (el) el.remove(); } catch { }
					try { const el = document.getElementById("dsh-hud-css"); if (el) el.remove(); } catch { }
				},
			};

			ctx.slots.inject("sidebar.session.row.leading", () =>
				ctx.slots.register({
					name: "sidebar.session.row.leading",
					id: "hud-row", order: 30,
				}, RowSeat));

			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: ID, order: 40, label: () => "HUD" }, HudIcon));

			ctx.slots.inject("main", () =>
				ctx.slots.register({ name: "main", key: ID }, HudPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = { HUE, readSettings, bucketsOf, forceState };
		return module.exports;
	}
});
