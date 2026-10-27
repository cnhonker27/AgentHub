/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 号池页顶部渠道切换（收起一行方块 / 展开全部卡片）的静态契约自测。
// 这一层不依赖 Electron 窗口，只锁住「改版后不能退回去」的几件事：
//   ① 默认形态是收起的一行，而不是旧的全部卡片网格；
//   ② 收起行高度与卡片高度是同一组 token 推导出来的 2/3 关系（改一个必须改另一个）；
//   ③ 收起态每个方块：有图标用图标、无图标回落名称首字母；
//   ④ 一行不成高/不出宽的结构约束（定高 + 横向滚动 + 箭头方块固定不参与收缩）。
// 真实渲染（像素级高度、点击切换、展开收起）另由 Electron 探针验证，这里只守源码契约。
// 用法：node tools/proxy-agents-switch-selftest.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const VIEW = path.join(ROOT, "src", "views", "proxy", "ProxyAgentsView.vue");
const ICONS = path.join(ROOT, "src", "views", "proxy", "channelIcons.ts");
const UPSTREAM = path.join(ROOT, "src", "components", "ProxyUpstreamDialog.vue");

let pass = 0;
let fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    bad.push(name + (extra ? "  <- " + extra : ""));
    console.log("  FAIL " + name + (extra ? "   <- " + extra : ""));
  }
}

const view = fs.readFileSync(VIEW, "utf8");
const icons = fs.readFileSync(ICONS, "utf8");
const upstream = fs.readFileSync(UPSTREAM, "utf8");

// ---- ① 默认收起 ----
ok("默认形态是收起（switcherCollapsed 初值 true）", /const switcherCollapsed = ref\(true\)/.test(view));
ok("进入页面时重置为收起（切走再回来不留展开态）", /switcherCollapsed\.value = true;/.test(view));
ok("收起态有独立容器 .ch-strip", /class="ch-strip"/.test(view));
ok("收起态只在 switcherCollapsed 时渲染", /v-if="switcherCollapsed"/.test(view));
ok("展开态仅在 else 分支（两形态互斥，不会同时出现）", /<template v-else>/.test(view));

// ---- ② 高度关系：卡片 60 / 收起行 40 ----
const cardH = view.match(/--ch-card-h:\s*(\d+)px/);
const stripH = view.match(/--ch-strip-h:\s*(\d+)px/);
ok("定义了卡片高度 token --ch-card-h", !!cardH, cardH ? cardH[0] : "missing");
ok("定义了收起行高度 token --ch-strip-h", !!stripH, stripH ? stripH[0] : "missing");
if (cardH && stripH) {
  const c = Number(cardH[1]);
  const s = Number(stripH[1]);
  ok("收起行高度 = 卡片高度的三分之二（固定比例，不是随手取的值）", Math.abs(s - (c * 2) / 3) <= 0.5, `card=${c} strip=${s}`);
  ok("收起行是「固定高度」（height 而不是 min-height）", /\.ch-strip\s*\{[^}]*height:\s*var\(--ch-strip-h\)/s.test(view));
  ok("展开态卡片高度吃同一个 token（两处不会各自漂移）", /\.channel-btn\s*\{[^}]*height:\s*var\(--ch-card-h/s.test(view));
}

// ---- ③ 图标 / 首字母 ----
ok("收起方块：有图标渲染 img", /v-if="CHANNEL_ICONS\[ch\.id\]"\s+:src="CHANNEL_ICONS\[ch\.id\]"/.test(view));
ok("收起方块：无图标渲染名称首字母", /<b v-else>\{\{\s*channelInitial\(ch\.id,\s*ch\.display\)\s*\}\}<\/b>/.test(view));
ok("首字母函数优先用服务端 display（与卡片同名，不各叫各的）", /display \|\| channelName\(id\)/.test(icons));
ok("图标映射是单一来源（上游启闭弹窗复用同一份，不各存一张表）", /from "\.\.\/views\/proxy\/channelIcons"/.test(upstream) && !/import traeIcon from/.test(upstream));
ok("图标映射按渠道 id 提供（覆盖内置渠道）", /trae:\s*traeIcon/.test(icons) && /zcode:\s*zcodeIcon/.test(icons));

// ---- ④ 一行不成高 / 不出宽 ----
ok("方块区自成一个横向滚动容器 .ch-strip-list", /\.ch-strip-list\s*\{[^}]*overflow-x:\s*auto/s.test(view));
ok("方块区纵向被裁掉（overflow-y: hidden 锁死行高）", /\.ch-strip-list\s*\{[^}]*overflow-y:\s*hidden/s.test(view));
ok("展开箭头方块不参与收缩（flex: 0 0 auto，渠道再多也留在最右）", /\.ch-sq-arrow\s*\{[^}]*flex:\s*0 0 auto/s.test(view));
ok("方块保持正方形（aspect-ratio: 1）", /\.ch-sq\s*\{[^}]*aspect-ratio:\s*1/s.test(view));
ok("方块有收缩下限（不会缩成看不清的小条）", /\.ch-sq\s*\{[^}]*min-width:\s*\d+px/s.test(view));

// ---- 交互 ----
ok("点方块即切换渠道（复用 activeChannel）", /class="ch-sq"[\s\S]{0,400}@click="activeChannel = ch\.id"/.test(view));
ok("收起态箭头方块负责展开", /ch-sq-arrow[\s\S]{0,200}@click="switcherCollapsed = false"/.test(view));
ok("展开态右下角箭头方块负责收起", /ch-strip-foot[\s\S]{0,300}@click="switcherCollapsed = true"/.test(view));
ok("收起态每个方块有悬浮提示（无文字位时仍能看出是哪个渠道）", /function stripTip\(ch: ProxyChannelView\)/.test(view));
ok("悬浮提示包含可用数与降级倒计时", /accountCount \? `\$\{ch\.summary\.onlineCount\}\/\$\{ch\.summary\.accountCount\} 可用`/.test(view) && /降级 \$\{channelCoolLeft\(ch\)\}/.test(view));
ok("降级中的渠道在收起态有红点提示", /class="ch-sq-dot"/.test(view));
ok("两种形态共用同一个选中渠道（形态切换不影响下方列表）", (view.match(/activeChannel/g) || []).length > 6);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  bad.forEach((b) => console.log("  - " + b));
  process.exit(1);
}
