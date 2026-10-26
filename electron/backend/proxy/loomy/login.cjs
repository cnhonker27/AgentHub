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
// 反代网关 · Loomy 手机号验证码登录（逆向自安装包 electron/xfyun/account-service.js）
//
// 链路两步，没有窗口、没有轮询：
//   POST {xfyun}/login/phone/sendMsgCode  {base, param:{ccode, phone, expire:300}}   → data.msgid
//   POST {xfyun}/login/phone/checkCode    {base, param:{ccode, phone, mcode, msgid, expire:1209600}}  ← 14 天
// 两个请求都带 HMAC-SHA1 签名头（见 sign.cjs）。
// base 信封字段取自客户端 _makeBase()：appid=GM3LOOMY / modelid="Web" / version="1.0.0" / devid="web" / ua / traceid。
//
// msgid 由前端带回：上游把「刚发的码」绑在发码响应的 msgid 上，登录必须带同一个。
// 网关不替用户保存这个中间态（一次登录可跨多次 HTTP、也可被放弃），回给前端随下一次请求带回最省事又不丢正确性。
//
// 设备标识：客户端 base.devid 固定 "web"（不是设备指纹），照抄即可，不需要生成。
"use strict";

const crypto = require("node:crypto");
const endpoints = require("./endpoints.cjs");
const client = require("./client.cjs");

const SEND_CODE_PATH = "/login/phone/sendMsgCode";
const LOGIN_PATH = "/login/phone/checkCode";
const WEB_MODEL_ID = "Web";
const WEB_DEVICE_ID = "web";
const CLIENT_UA = "Loomy|Desktop|Electron|macOS";
const CLIENT_VERSION = "1.0.0";

// 与客户端 sendSmsCode 的 ^1[3-9]\d{9}$ 同口径，容忍 +86 / 86 前缀与空格、连字符
function normalizePhone(raw) {
  const trimmed = String(raw || "").replace(/[\s-]/g, "");
  let digits = trimmed.startsWith("+86") ? trimmed.slice(3) : trimmed;
  if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("1") && "3456789".includes(digits[1]) && /^\d+$/.test(digits)) {
    return digits;
  }
  throw Object.assign(new Error("请填写 11 位中国大陆手机号"), { status: 400 });
}

function normalizeCode(raw) {
  const code = String(raw || "").trim();
  if (code.length === 6 && /^\d+$/.test(code)) return code;
  throw Object.assign(new Error("请填写 6 位数字验证码"), { status: 400 });
}

// 请求信封 base（客户端 _makeBase()：traceid 是随机十六进制）
function makeBase() {
  return {
    appid: endpoints.appId(),
    modelid: WEB_MODEL_ID,
    version: CLIENT_VERSION,
    devid: WEB_DEVICE_ID,
    ua: CLIENT_UA,
    traceid: crypto.randomBytes(16).toString("hex"),
  };
}

// 业务码 → 用户能看懂的原因（上游参数类错误文案对用户没有指导意义，按码翻成「该做什么」）
function describeLoginError(code, upstreamMsg) {
  if (code === "020002" || code === "100002") return "登录态已失效，请重新登录";
  const msg = String(upstreamMsg || "").trim();
  return msg ? `登录失败：${msg}` : `登录失败（上游 code=${code}）`;
}

// 从发码响应里取 msgid（上游字段名在不同版本出现过 msgid / msgId 两种形态，且可能落在 data 或 data.data 两层）
function extractMsgid(payload) {
  const candidates = [payload && payload.data && payload.data.msgid, payload && payload.data && payload.data.msgId,
    payload && payload.data && payload.data.data && payload.data.data.msgid, payload && payload.data && payload.data.data && payload.data.data.msgId];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function maskPhone(phone) {
  const p = String(phone || "");
  return p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
}

// 发送短信验证码，返回 { msgid }（前端随登录请求带回）
async function sendCode(phone, fetchImpl) {
  const normalized = normalizePhone(phone);
  const body = { base: makeBase(), param: { ccode: "86", phone: normalized, expire: 300 } };
  const payload = await client.signedPost(SEND_CODE_PATH, body, "发送验证码", fetchImpl);
  const code = client.businessCode(payload);
  if (code !== client.SUCCESS_CODE) {
    throw Object.assign(new Error(describeLoginError(code, client.upstreamMessage(payload))), { status: 400, loomyCode: code });
  }
  const msgid = extractMsgid(payload);
  if (!msgid) {
    throw Object.assign(new Error("验证码已发出但上游没有返回 msgid，请稍后重试"), { status: 502 });
  }
  return { msgid, phoneTail: maskPhone(normalized) };
}

// 用手机号 + 验证码登录，返回可直接落账号的凭证对象 {session, userid, phone, phoneTail}
async function loginWithCode(phone, code, msgid, fetchImpl) {
  const normalized = normalizePhone(phone);
  const normalizedCode = normalizeCode(code);
  if (!String(msgid || "").trim()) {
    throw Object.assign(new Error("缺少 msgid：请先点「发送验证码」，用本次发码返回的 msgid 登录"), { status: 400 });
  }
  const body = {
    base: makeBase(),
    param: { ccode: "86", phone: normalized, mcode: normalizedCode, msgid: String(msgid).trim(), expire: 14 * 24 * 3600 },
  };
  const payload = await client.signedPost(LOGIN_PATH, body, "登录", fetchImpl);
  const status = client.businessCode(payload);
  if (status !== client.SUCCESS_CODE) {
    throw Object.assign(new Error(describeLoginError(status, client.upstreamMessage(payload))), { status: 400, loomyCode: status });
  }
  const data = (payload && payload.data && typeof payload.data === "object") ? payload.data : {};
  const session = String(data.session || "").trim();
  if (!session) {
    throw Object.assign(new Error("登录成功但上游没有返回 session"), { status: 502 });
  }
  const userid = String(data.userid || "").trim();
  return { session, userid, phone: normalized, phoneTail: maskPhone(normalized) };
}

module.exports = { sendCode, loginWithCode };
