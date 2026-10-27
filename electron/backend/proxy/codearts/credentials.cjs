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
// 反代网关 · CodeArts 凭据解析与续期（ensure_fresh）
//
// 凭据是一次 OAuth/PKCE 登录换来的临时三元组（AK/SK/STS），到期前 15 分钟就要续。
// 「长期那一半」是 OAuth 上下文（DPoP 密钥对 + code_verifier）——续期不能只靠 refresh token：
// 同一个令牌请求还要出示当初登录所用的 PKCE verifier 与 DPoP 私钥，所以凭据是一整块，不能只存 AK/SK/STS。
//
// 续期两条纪律：
//   * 同一个 refresh token 只能换一次 → 进程级单飞表，并发 401 共享同一次刷新（防轮换互相践踏）；
//   * 刷新走 ensure_fresh 必须回写账号记录（这是本机自己的库），身份/域名不允许被续期结果改掉（串号防护）。
"use strict";

const oauth = require("./oauth.cjs");

// 到期前 15 分钟就续（refreshMarginMs 可经 headers.json 覆盖）
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

// 凭据整块存在 store 的 token 列（JSON 串，列本身由 store 加密落盘）；这里摊回字段。
// 旧的扁平形态（手工粘贴凭据 JSON）继续认，别把历史账号读成空凭据。
function unpack(secrets) {
  const raw = String((secrets && secrets.token) || "");
  if (!raw.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.accessKeyId ? parsed : null;
  } catch {
    return null;
  }
}

// 从账号行的凭据字段（整块 JSON / 扁平字段 / meta）还原出完整凭据对象
function credentialFrom(account, secrets) {
  const s = secrets || {};
  const packed = unpack(secrets);
  const meta = (account && account.meta) || {};
  const ctx = (packed && packed.oauthContext) || meta.oauthContext || s.oauthContext || null;
  return {
    access_key_id: String((packed && packed.accessKeyId) || s.accessKeyId || s.access_key_id || "").trim(),
    secret_access_key: String((packed && packed.secretAccessKey) || s.secretAccessKey || s.secret_access_key || "").trim(),
    security_token: String((packed && packed.securityToken) || s.securityToken || s.security_token || "").trim(),
    domain_id: String(meta.domainId || meta.domain_id || s.domainId || "").trim(),
    user_id: String(meta.userId || meta.user_id || s.userId || "").trim(),
    user_name: String(meta.userName || meta.user_name || s.userName || "").trim(),
    refresh_token: String((packed && packed.refreshToken) || s.refreshToken || s.refresh_token || "").trim(),
    expires_at: Number((packed && packed.expiresAt) || s.expiresAt || s.expires_at || meta.expiresAt || 0) || 0,
    login_type: String(meta.loginType || meta.login_type || "WEB"),
    oauth_context: ctx,
  };
}

/** 凭据整块 → store 的两个加密列。DPoP 私钥与 PKCE verifier 也在整块里：
 *  只存 AK/SK/STS 的账号一小时后必然续不回来，等于一次性凭据。 */
function toStoreFields(credential) {
  return {
    token: JSON.stringify({
      accessKeyId: credential.access_key_id,
      secretAccessKey: credential.secret_access_key,
      securityToken: credential.security_token,
      refreshToken: credential.refresh_token,
      expiresAt: credential.expires_at,
      oauthContext: credential.oauth_context || null,
    }),
    refreshToken: credential.refresh_token,
    expiresAt: credential.expires_at,
  };
}

function valid(credential) {
  return !!(credential && credential.access_key_id && credential.secret_access_key && credential.security_token);
}

// 是否临期（到期前 REFRESH_MARGIN_MS 内）
function expiring(credential) {
  if (!credential || !credential.expires_at) return true; // 没写到期时间按临期处理
  return credential.expires_at - Date.now() <= REFRESH_MARGIN_MS;
}

// 进程级单飞表：同一 refresh token 的并发续期共享同一次
const flights = new Map();

// 从 refresh token 的 JWT 载荷补身份（续期响应不带身份）
function inheritIdentity(fresh, existing) {
  const fromJwt = oauth.identityFromRefreshToken(fresh.refresh_token);
  return {
    ...fresh,
    domain_id: fresh.domain_id || (fromJwt && fromJwt.domain_id) || existing.domain_id || "",
    user_id: fresh.user_id || (fromJwt && fromJwt.user_id) || existing.user_id || "",
    user_name: fresh.user_name || (fromJwt && fromJwt.user_name) || existing.user_name || "",
    login_type: existing.login_type || "WEB",
    oauth_context: existing.oauth_context,
  };
}

/**
 * 确保拿到可用凭据（force=true 不看临期窗口，401 之后强制刷一次）。
 * 返回 { ok, credential, refreshed?, fields? }；失败 { ok:false, message, status? }。
 * `fields` 是可直接交给 store.updateAccount 的回写补丁（整块凭据）。
 */
async function ensureFresh(account, secrets, force) {
  const existing = credentialFrom(account, secrets);
  if (!force && !expiring(existing)) {
    return { ok: true, credential: existing };
  }
  if (!existing.refresh_token || !existing.oauth_context) {
    return { ok: false, message: "CodeArts 凭据缺少 refresh token / OAuth 上下文，无法续期，请重新登录" };
  }
  const key = existing.refresh_token.slice(0, 24);
  if (flights.has(key)) return flights.get(key);

  const promise = (async () => {
    try {
      const fresh = await oauth.refreshCredential(existing);
      const merged = inheritIdentity(fresh, existing);
      // 身份 / 域名不允许被续期结果改掉（串号防护）；凭据整块回写
      merged.domain_id = existing.domain_id || merged.domain_id;
      merged.user_id = existing.user_id || merged.user_id;
      return { ok: true, credential: merged, refreshed: true, fields: toStoreFields(merged) };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e), status: (e && e.status) || 502 };
    }
  })();

  flights.set(key, promise);
  try {
    return await promise;
  } finally {
    flights.delete(key);
  }
}

module.exports = { credentialFrom, toStoreFields, valid, expiring, ensureFresh, REFRESH_MARGIN_MS };
