/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Accio 额度查询：归一成账号页统一形状
//
// 上游给的是什么：GET /api/entitlement/quota?accessToken=… → {usagePercent, refreshCountdownSeconds}
// （桌面端本地路由 /auth/quota 就是把它算成这两个数给界面用）。另有
// GET /api/entitlement/currentSubscription?accessToken=… 给订阅详情（套餐名 / 到期 / 剩余），可能不存在（免费账号）。
//
// 为什么 available 给 null：Accio 不暴露「还剩多少积分」的绝对数，只有一个已用百分比。
// 把百分比伪装成积分数会误导（用户看到「还剩 37」不知道是什么单位）。处置：
//   - available = null；unit = "%"；
//   - wallets 里给一条「额度余量」= 100 - usagePercent，把重置倒计时写进 detail；
//   - subscription 用 remainQuota / totalQuota（都是百分比）承载同一件事，免得前端只认 subscription 时什么都显示不出来。
//
// 401 原样透出：调用方据此走「刷新后重试一次」链路。
"use strict";

const auth = require("./auth.cjs");
const endpoints = require("./endpoints.cjs");

// 秒 → 「3 小时 20 分」这类人话
function humanizeSeconds(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${total} 秒`;
}

// 订阅响应 → 统一 subscription 形状（宽键名）
function subscriptionShape(payload) {
  const p = payload || {};
  const text = (keys) => {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  const number = (keys) => {
    for (const k of keys) {
      const v = Number(p[k]);
      if (Number.isFinite(v)) return v;
    }
    return null;
  };
  let expireAt = null;
  for (const k of ["expireAt", "expiresAt", "endTime", "end_time"]) {
    if (p[k] !== undefined && p[k] !== null) { expireAt = p[k]; break; }
  }
  return {
    planName: text(["planName", "plan_name", "productName", "name"]),
    status: text(["status", "state"]),
    expireAt,
    remainQuota: number(["remainQuota", "remain", "remaining", "leftQuota"]),
    totalQuota: number(["totalQuota", "total", "quota"]),
  };
}

/**
 * 查一个渠道的额度 / 订阅，归一成统一形状。
 * env = { token }（accessToken）。
 */
async function queryBalance(channel, env) {
  const token = String((env && env.token) || "").trim();
  if (!token) return { authError: true, message: "该账号没有凭据" };

  // ── 额度用量 ──
  let quotaResponse;
  try {
    quotaResponse = await auth.getWithToken(channel, endpoints.QUOTA_PATH, token, {});
  } catch (e) {
    if (e && e.status === 401) return { authError: true, message: "Accio 凭证已失效，请重新登录" };
    return { error: String((e && e.message) || e) };
  }
  if (quotaResponse.status === 401 || quotaResponse.status === 403) {
    return { authError: true, message: "Accio 凭证已失效，请重新登录" };
  }
  if (!quotaResponse.ok) {
    return { error: `Accio 额度查询失败（HTTP ${quotaResponse.status}）` };
  }
  const quota = auth.unwrapData(quotaResponse.data);
  const usagePercent = Math.min(100, Math.max(0, Number((quota && (quota.usagePercent || quota.usage_percent)) || 0)));
  const countdownRaw = Number((quota && (quota.refreshCountdownSeconds || quota.refresh_countdown_seconds)));
  const countdown = Number.isFinite(countdownRaw) ? countdownRaw : null;
  const remain = Math.max(0, 100 - usagePercent);

  // ── 订阅（可选，失败不影响额度展示）──
  let subscription = null;
  try {
    const subResponse = await auth.getWithToken(channel, endpoints.SUBSCRIPTION_PATH, token, {});
    if (subResponse.ok && subResponse.data) {
      subscription = subscriptionShape(auth.unwrapData(subResponse.data));
    }
  } catch { /* 免费账号没有订阅：失败当「没有」 */ }

  const wallet = {
    type: "entitlement",
    displayName: "额度余量",
    balance: remain,
    unit: "%",
    usedPercent: usagePercent,
  };
  if (countdown != null && countdown > 0) wallet.detail = `${humanizeSeconds(countdown)} 后重置`;

  return {
    available: null, // 上游只有百分比，没有绝对剩余量（按契约给 null）
    unit: "%",
    wallets: [wallet],
    subscription,
    raw: { quota },
  };
}

module.exports = { queryBalance };
