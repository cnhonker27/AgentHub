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
// 反代网关 · Loomy 账号（CAccount）请求签名：HMAC-SHA1（复刻客户端 xfyun/sign.js）
//
// 待签字符串是 9 段、以 \n 连接（与客户端 generateSignature 逐字同构）：
//   METHOD / ESCAPED_PATH / ESCAPED_QUERY / CONTENT_MD5 / CONTENT_TYPE / DATE / NONCE / SIGNED_HEADERS / CANONICALIZED_HEADERS
// 其中 ESCAPED_QUERY、SIGNED_HEADERS、CANONICALIZED_HEADERS 在本项目所有账号接口上恒为空串，
// 因此末两段是空串、拼接结果在 nonce 之后以两个 \n 结尾 —— 用数组 join 而非手写 format，
// 正是为了让段数与分隔符数量不可能被写错。
//
// 两处易错点（必须照做）：
//   1. 路径要有前导 / 且不以 / 结尾（客户端 buildEscapedPath 会去掉尾部斜杠）；
//   2. Content-MD5 必须覆盖「实际发出去的字节」：签名与发送都走紧凑序列化（JSON.stringify 无空格形态），
//      两处必须保持同一序列化口径 —— 换任何一方都会让 MD5 对不上，上游报签名错误。
//
// HMAC-SHA1 不是安全边界：这是客户端指纹复刻（密钥随安装包分发，见 endpoints.cjs），
// 目标是与官方客户端行为一致，不是密码学意义上的完整性保证。
"use strict";

const crypto = require("node:crypto");
const endpoints = require("./endpoints.cjs");

const CONTENT_TYPE = "application/json";

// 保留字符集：等价 JS encodeURIComponent 后再保留 !'()* （RFC3986 §3.3 逐段编码）
const UNRESERVED = /^[A-Za-z0-9\-_.!~*'()]$/;

function escapePathSegment(segment) {
  let out = "";
  for (const ch of segment) {
    if (UNRESERVED.test(ch)) out += ch;
    else {
      for (const byte of Buffer.from(ch, "utf8")) out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// 前导 /、去尾斜杠、逐段转义、以 / 连接
function buildEscapedPath(path) {
  let clean = String(path || "");
  if (!clean.startsWith("/")) clean = "/" + clean;
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean.split("/").map(escapePathSegment).join("/");
}

// UTC 的 `Sun, 06 Oct 2026 12:34:56 GMT` 形态（对应 JS new Date().toUTCString()）
function utcDateString() {
  return new Date().toUTCString();
}

// base64(md5(body 字节串))；空串输入返回空串（对应客户端 contentMD5('')）
function contentMd5(bodyString) {
  if (!bodyString) return "";
  return crypto.createHash("md5").update(bodyString, "utf8").digest("base64");
}

/**
 * 生成一次请求的签名头集合：Authorization / Date / Nonce / Content-MD5。
 * body 为 null/undefined 时按空 body 处理（MD5 段为空串）。
 * 序列化口径必须与发送侧完全一致（紧凑 JSON.stringify，见适配器）。
 */
function signedHeaders(method, path, body) {
  const bodyString = body == null ? "" : JSON.stringify(body);
  const md5 = contentMd5(bodyString);
  const date = utcDateString();
  const nonce = crypto.randomUUID();
  const stringToSign = [
    String(method || "POST").toUpperCase(),
    buildEscapedPath(path),
    "",
    md5,
    CONTENT_TYPE,
    date,
    nonce,
    "",
    "",
  ].join("\n");

  const signature = crypto
    .createHmac("sha1", endpoints.accessKeySecret())
    .update(stringToSign, "utf8")
    .digest("base64");

  const headers = {
    Authorization: `account ${endpoints.accessKeyId()}:${signature}`,
    Date: date,
    Nonce: nonce,
  };
  if (md5) headers["Content-MD5"] = md5;
  return headers;
}

module.exports = { signedHeaders, buildEscapedPath };
