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
// 反代网关 · Accio 网页登录：OAuth 2.0 授权码 + PKCE（S256）
//
// 协议（逆向自桌面端 AuthService）：
//   ① 生成 code_verifier（随机）/ code_challenge（SHA-256 → base64url）
//   ② 打开 {loginBase}/login?return_url=<本机回调>&state=<state>&code_challenge=<c>&code_challenge_method=S256&client_id=accio-work
//   ③ 用户登录完成 → 登录页把 ?code=…&state=… 拼到 return_url 上跳回来
//   ④ POST {gw}/api/oauth/token  {code, codeVerifier, clientId, redirectUri} → {accessToken, refreshToken, expiresAt}
// client_id 是桌面端常量（accio-work，两地共用）；redirectUri 必须与第 ② 步的 return_url 逐字相同，
// 因此它跟着 pending 一起存下来原样回传。
//
// 为什么要 PKCE 与 state（而不是只带一个 code）：回调落在本机 HTTP 端口上，任何本机进程都能伪造一次 GET。
// 两道闸门各挡一类问题：state ← 这次回调是不是本进程刚发起的那一轮（逐字比对，不匹配就拒绝，
// 否则别人可以拿自己那次的 code 把凭证写进你的账号库）；code_verifier ← 授权码被截获也换不出 token。
// 两者只在内存、不落盘（进程重启 = 那次登录作废）。
"use strict";

const crypto = require("node:crypto");
const auth = require("./auth.cjs");
const endpoints = require("./endpoints.cjs");

// 一轮登录的有效期（与登录任务的超时同量级）
const PENDING_TTL_MS = 6 * 60 * 1000;

// pending 表：state → { channel, verifier, redirectUri, createdAt }；只在内存
const pending = new Map();

function sweep() {
  const now = Date.now();
  for (const [state, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(state);
}

// 一次性随机串（code_verifier / state 用）：32 字节 → base64url（43 字符），落在 PKCE 要求的 43–128 之间
function randomSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

// 授权页地址（return_url 走本机 loopback 回调；桌面端把 trace 参数塞进 return_url 是它的埋点需要，不带）
function buildAuthorizeUrl(channel, state, challenge, returnUrl) {
  const region = endpoints.regionOf(channel);
  const q = new URLSearchParams({
    return_url: returnUrl,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    client_id: endpoints.CLIENT_ID,
  });
  return `${region.loginBase}/login?${q.toString()}`;
}

// 登记一轮登录（生成 state + verifier，产出授权地址）
function beginLogin(channel, returnUrl) {
  const verifier = randomSecret();
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  sweep();
  pending.set(state, { channel, verifier, redirectUri: returnUrl, createdAt: Date.now() });
  return { authUrl: buildAuthorizeUrl(channel, state, challenge, returnUrl), state };
}

// 取走一轮登录（回调进来时调用；取走即失效，重复回调拿不到第二次）
function takePending(state) {
  sweep();
  const entry = pending.get(String(state || ""));
  if (!entry) return null;
  pending.delete(String(state));
  return entry;
}

function dropPending(state) {
  pending.delete(String(state || ""));
}

// 用授权码换凭证（POST /api/oauth/token）
async function exchangeCode(channel, code, verifier, redirectUri) {
  const body = { code, codeVerifier: verifier, clientId: endpoints.CLIENT_ID, redirectUri };
  const response = await auth.postJson(channel, endpoints.OAUTH_TOKEN_PATH, body);
  if (!response.ok) {
    throw Object.assign(new Error(`Accio 授权码换令牌失败（HTTP ${response.status}）`), { status: response.status });
  }
  const data = auth.unwrapData(response.data);
  const accessToken = String((data && (data.accessToken || data.access_token || data.token)) || "").trim();
  if (!accessToken) {
    throw Object.assign(new Error("Accio 换码响应缺少 accessToken"), { status: 502 });
  }
  const refreshToken = String((data && (data.refreshToken || data.refresh_token)) || "").trim();
  const expiresAt = Number(data && (data.expiresAt || data.expires_at)) || 0;
  return { accessToken, refreshToken, expiresAt };
}

// 从回调 query 里取 code / state（两个都必需）
function parseCallback(query) {
  const error = String((query && query.error) || "").trim();
  if (error) throw Object.assign(new Error(`授权被拒绝（${error}）`), { status: 400 });
  const code = String((query && query.code) || "").trim();
  const state = String((query && query.state) || "").trim();
  if (!code) throw Object.assign(new Error("回调没有携带授权码"), { status: 400 });
  if (!state) throw Object.assign(new Error("回调没有携带 state，无法确认这次登录归属"), { status: 400 });
  if (code.length > 8192 || state.length > 512) {
    throw Object.assign(new Error("回调参数超长，已拒绝"), { status: 400 });
  }
  return { code, state };
}

module.exports = { beginLogin, takePending, exchangeCode, parseCallback, buildAuthorizeUrl };
