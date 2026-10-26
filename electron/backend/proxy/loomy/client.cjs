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
// 反代网关 · Loomy 两种出站请求的薄封装：签名 POST（CAccount）与 token 请求（集成网关）
//
// 收在一处的理由：登录 / 签到 / 余额 / 目录共用同一套超时、错误翻译与「业务码 → 人话」口径，
// 各写一份会让「哪个码算登录失效」这类判据分叉。
//
// 业务码口径（实测 + 客户端源码对照）：CAccount 与集成网关都用 HTTP 200 + {code, desc, data}
// 表达业务结果 —— 000000 成功；020002 / 100002 登录态无效（客户端 AUTH_ERROR_CODES，分别来自
// CAccount 与业务网关）；其余业务失败，desc 是上游文案。模型列表接口不返回 code。
"use strict";

const endpoints = require("./endpoints.cjs");
const sign = require("./sign.cjs");

const REQUEST_TIMEOUT_MS = 20000; // 登录 / 积分接口超时（与客户端 30s 对齐，略收紧）
const SUCCESS_CODE = "000000";
const AUTH_ERROR_CODES = new Set(["020002", "100002"]);

function businessCode(payload) {
  return String((payload && payload.code) || "").trim();
}
function isAuthErrorCode(code) {
  return AUTH_ERROR_CODES.has(String(code || ""));
}
function upstreamMessage(payload) {
  const p = payload || {};
  return String(p.desc || p.message || "").trim();
}

/**
 * 向 CAccount 发一次带签名的 POST（登录链路，无账号上下文）。
 * 返回上游响应体（{code, desc, data}）；HTTP 层失败翻译成带 status 的错误，业务码由调用方判。
 */
async function signedPost(path, body, what, fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const url = `${endpoints.xfyunBaseUrl()}${path}`;
  const headers = { "Content-Type": "application/json", ...sign.signedHeaders("POST", path, body) };
  let resp;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      resp = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    throw Object.assign(new Error(timedOut ? `${what}超时，请稍后重试` : `${what}失败：${e.message}`), {
      status: timedOut ? 504 : 502,
    });
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw Object.assign(new Error(`${what}返回 HTTP ${resp.status}（上游地址 ${endpoints.xfyunBaseUrl()}）`), {
      status: resp.status,
      body: text,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 向集成网关发一次带 token（= 登录 session）的请求。
 * path 形如 /api/v1/points/first-login；query 以 query string 形态直接拼在 path 后（调用方拼好）。
 * 登录态失效（业务码）由调用方判定 —— 不同接口的成功码判定不同（模型列表接口不返回 code）。
 */
async function tokenRequest(method, path, session, body, what, fetchImpl) {
  if (!String(session || "").trim()) {
    throw Object.assign(new Error("Loomy 账号缺少 session"), { status: 401 });
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  const url = `${endpoints.integrationBaseUrl()}${path}`;
  const headers = {
    token: session,
    Authorization: `Bearer ${session}`,
    "Content-Type": "application/json",
  };
  let resp;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      resp = await fetchFn(url, {
        method: method || "GET",
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    throw Object.assign(new Error(timedOut ? `${what}超时，请稍后重试` : `${what}失败：${e.message}`), {
      status: timedOut ? 504 : 502,
    });
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error(`${what}：Loomy 登录态已失效，请重新登录（HTTP ${resp.status}）`), { status: 401 });
    }
    throw Object.assign(new Error(`${what}返回 HTTP ${resp.status}`), { status: resp.status, body: text });
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { signedPost, tokenRequest, businessCode, isAuthErrorCode, upstreamMessage, SUCCESS_CODE };
