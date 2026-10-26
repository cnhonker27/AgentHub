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
// 反代网关 · Loomy（讯飞）上游地址与客户端内置签名对（环境变量可覆盖）
//
// 三套平面各一个域（逆向自 Loomy 桌面端安装包 app.asar 的 .env.prod 与 bundled-resources.js）：
//   账号 CAccount      https://account.xfinfr.com       （HMAC-SHA1 签名头，见 sign.cjs）
//   集成网关（积分）   https://loomyad.xunfei.cn         （明文 session 放 `token` 头）
//   模型网关           {集成网关}/api/v1                 （OpenAI 兼容，token + Bearer 双头）
// 模型网关没有独立配置 —— 客户端把它拼成「积分基址 + /api/v1」，这里同款拼接。
//
// 签名对为什么内置：CAccount 的每个请求都用客户端内置 AccessKey 对签 HMAC-SHA1，
// 没有它登录接口一个都调不通。这是客户端指纹复刻（密钥随安装包分发，非用户账号凭证），
// 内置为默认值、环境变量可覆盖，改动不需要重新打包。
"use strict";

const DEFAULT_XFYUN_BASE_URL = "https://account.xfinfr.com";
const DEFAULT_INTEGRATION_BASE_URL = "https://loomyad.xunfei.cn";
const DEFAULT_ACCESS_KEY_ID = "2thryby66wxi53sk";
const DEFAULT_ACCESS_KEY_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r";
const DEFAULT_APP_ID = "GM3LOOMY";

function envOverride(name) {
  const v = String(process.env[name] || "").trim().replace(/\/+$/, "");
  return v || null;
}

module.exports = {
  xfyunBaseUrl: () => envOverride("LOOMY_XFYUN_BASE_URL") || DEFAULT_XFYUN_BASE_URL,
  integrationBaseUrl: () => envOverride("LOOMY_POINTS_BASE_URL") || DEFAULT_INTEGRATION_BASE_URL,
  modelBaseUrl: () => `${module.exports.integrationBaseUrl()}/api/v1`,
  accessKeyId: () => envOverride("LOOMY_XFYUN_ACCESS_KEY_ID") || DEFAULT_ACCESS_KEY_ID,
  accessKeySecret: () => envOverride("LOOMY_XFYUN_ACCESS_KEY_SECRET") || DEFAULT_ACCESS_KEY_SECRET,
  appId: () => envOverride("LOOMY_XFYUN_APP_ID") || DEFAULT_APP_ID,
};
