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
// 反代网关 · Accio 凭证续期
//
// 上游：POST /api/auth/refresh_token，body {accessToken, refreshToken} → {accessToken, refreshToken, expiresAt}。
// 桌面端多账号场景的账号切换安全版是 /api/auth/safe/refresh_token，本网关不做账号切换，走普通那条。
// 响应里的 sid / sgcookie 不落库（那是浏览器侧会话的伴随标识，用不上，少存两个敏感值）。
//
// 上游没回过期时间怎么办：给一个保守默认值（1 小时）。它只影响「下次要不要续期」的判定，
// 给短了多刷一次（无害），给长了会让一个已失效的 token 留着不走续期路径（有害）。
"use strict";

const auth = require("./auth.cjs");
const endpoints = require("./endpoints.cjs");

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小时（桌面端 token 有效期在小时级，1 小时是安全的下界）

// 同一凭证只刷一次的进程级单飞表（并发 401 共享同一次刷新，防 refreshToken 轮换互相践踏）
const flights = new Map(); // key -> Promise

/**
 * 续期：拿 secrets 里的 accessToken + refreshToken 换一套新的。
 * 返回 { ok, token, refreshToken, expiresAt, noPersist? }；失败返回 { ok:false, message, status? }。
 */
async function refreshToken(channel, secrets) {
  const accessToken = String((secrets && secrets.token) || "").trim();
  const refreshToken = String((secrets && secrets.refreshToken) || "").trim();
  if (!accessToken || !refreshToken) {
    return { ok: false, message: "Accio 账号缺少 accessToken / refreshToken，无法续期，请重新登录或粘贴完整凭证" };
  }
  const key = `${channel}:${accessToken.slice(0, 16)}:${refreshToken.slice(0, 16)}`;
  if (flights.has(key)) return flights.get(key);

  const promise = (async () => {
    const body = { accessToken, refreshToken };
    let response;
    try {
      response = await auth.postJson(channel, endpoints.REFRESH_TOKEN_PATH, body);
    } catch (e) {
      return { ok: false, message: `Accio 续期请求失败：${(e && e.message) || e}`, status: (e && e.status) || 502 };
    }
    if (!response.ok) {
      return { ok: false, message: `Accio 续期被拒（HTTP ${response.status}）`, status: response.status };
    }
    const data = auth.unwrapData(response.data);
    const token = String((data && (data.accessToken || data.access_token || data.token)) || "").trim();
    if (!token) {
      return { ok: false, message: "Accio 续期响应缺少 accessToken，旧凭证未被覆盖" };
    }
    const nextRefresh = String((data && (data.refreshToken || data.refresh_token)) || "").trim() || refreshToken;
    const expiresAt = Number(data && (data.expiresAt || data.expires_at)) || Date.now() + DEFAULT_TTL_MS;
    return { ok: true, token, refreshToken: nextRefresh, expiresAt };
  })();

  flights.set(key, promise);
  try {
    return await promise;
  } finally {
    flights.delete(key);
  }
}

module.exports = { refreshToken };
