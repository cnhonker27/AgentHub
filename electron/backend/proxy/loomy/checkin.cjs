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
// 反代网关 · Loomy 每日签到 = 每日首次登录刷新赠送积分（逆向确认）
//
// 上游是什么（安装包全包检索 + points-service.js 对照）：Loomy 没有独立的签到 / 领取接口，
// 客户端全包检索「签到 / checkin / 每日任务」零命中。它每天把「每日赠送积分」刷回 5000 的机制是：
//   POST {集成网关}/api/v1/points/first-login      header: token: <session>
//   body: {}（可带 inviteCode / deviceId / channel，签到场景都不需要）   → {code:"000000", desc, data:{…}}
// 客户端每次登录成功后都会调它（短信登录与微信绑定两条路径都调），服务端以「当天是否第一次」
// 决定是否把赠送额度刷回 5000。这里把同一个调用接进自动签到框架，让长期不登录的账号也能每天续上。
//
// 判成功口径（与别家对齐）：HTTP 通了且业务码 000000 才算 success。重复调用是按天幂等的
// （服务端当天已刷过就原样返回成功），所以「今天已刷过」不算失败 —— 与 AutoClaw 不同，
// 这里没有可区分的返回字段，如实报成功并说明「每日赠送积分已刷新」。
"use strict";

const client = require("./client.cjs");

const FIRST_LOGIN_PATH = "/api/v1/points/first-login";

/**
 * Loomy 账号的每日积分刷新（自动签到框架的 claim）。
 * env = { session }；返回 { ok, already?, message, credit?, reward? }，对齐 AgentHub 签到契约。
 */
async function checkin(env, fetchImpl) {
  const session = String((env && env.session) || "").trim();
  if (!session) return { ok: false, authError: true, message: "Loomy 账号缺少 session" };
  let payload;
  try {
    payload = await client.tokenRequest("POST", FIRST_LOGIN_PATH, session, {}, "每日积分刷新", fetchImpl);
  } catch (e) {
    if (e && e.status === 401) return { ok: false, authError: true, message: "Loomy 登录态已失效，无法刷新每日积分（请重新登录）" };
    return { ok: false, message: String((e && e.message) || e) };
  }
  const code = client.businessCode(payload);
  if (client.isAuthErrorCode(code)) {
    return { ok: false, authError: true, message: "Loomy 登录态已失效，无法刷新每日积分（请重新登录）" };
  }
  if (code !== client.SUCCESS_CODE) {
    const msg = client.upstreamMessage(payload);
    return { ok: false, message: msg ? `每日积分刷新失败：${msg}` : `每日积分刷新失败（上游 code=${code}）` };
  }
  // 响应里可能带今日的赠送额度（字段名未在客户端硬编码，取到就播报）
  const data = (payload && payload.data) || {};
  const inner = data && typeof data.data === "object" && data.data ? data.data : data;
  const daily = typeof inner.dailyBalance === "number" ? inner.dailyBalance : null;
  const message = daily != null ? `每日赠送积分已刷新（当前 ${daily}）` : "每日赠送积分已刷新";
  return { ok: true, already: false, message, credit: daily != null ? daily : undefined };
}

module.exports = { checkin };
