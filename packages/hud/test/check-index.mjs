// 校验 market-index.json 是否符合 DSH 插件市场索引格式 1
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("@deepseek-ai/dsh-plugin-market-index");

const file = process.argv[2] || "C:/Users/Administrator/Documents/deepseek-harness/default-workspace/dsh-plugins/market-index.json";
const url = "https://raw.githubusercontent.com/em-chester/dsh-plugins/main/market-index.json";
const json = JSON.parse(fs.readFileSync(file, "utf8"));

const parse = mod.parseMarketIndex || (mod.default && mod.default.parseMarketIndex);
if (!parse) {
  console.log("导出的成员:", Object.keys(mod));
  process.exit(2);
}

try {
  const idx = parse(json, url);
  console.log("✅ 索引校验通过");
  console.log("  标题:", typeof idx.title === "string" ? idx.title : idx.title.zh || idx.title.en);
  for (const p of idx.plugins) {
    console.log("  插件:", p.name, "版本:", p.versions.map((v) => v.version).join(", "));
    const v = p.versions[0];
    const target = mod.marketInstallTarget(p.name, v);
    console.log("  安装参数:", target.spec);
  }
} catch (e) {
  console.log("❌ 校验失败:", e.message || e);
  if (e.path) console.log("   位置:", e.path, e.reason || "");
  process.exit(1);
}
