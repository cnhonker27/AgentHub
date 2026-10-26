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
// 反代网关 · Loomy（讯飞）渠道适配器：无状态 OpenAI 兼容上游 + 短信登录
//
// 三套平面见 endpoints.cjs；本家无状态（一次 HTTP 请求 = 一次回答，OpenAI 协议），
// 不声明 stateful，走默认单发 chat()。唯一需要的是 HMAC-SHA1 签名（账号域，登录用）与图片适配。
//
// 三处与别家不同的取舍：
//   1. 没有续期（supports_refresh=false）：session 14 天，上游没有 refresh 接口，
//      过期（020002 / 100002）只能重新短信登录 —— refreshToken 返回不可用；
//   2. 没有桌面端导入：登录态不在可读文件里；
//   3. 没有内置兜底模型清单：官方 imodel 网关 /models 拉不到就如实报错，不编模型名。
//
// 鉴权双头：token + Authorization: Bearer（上游模型 / 积分两个网关对头名偏好不同，双写两边都安全）。
// model 原样透传：Loomy 的模型 id 就是上游 id，无路由前缀，入口校验已按目录收窄。
"use strict";

const endpoints = require("./endpoints.cjs");
const client = require("./client.cjs");
const images = require("./images.cjs");
const balance = require("./balance.cjs");
const checkin = require("./checkin.cjs");
const models = require("./models.cjs");

function makeLoomy(deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
  const cfg = () => (rules.get("headers.json") || {}).loomy || {};
  const channel = "loomy";

  // session 即 auth.accessToken（与另外几家同一约定）
  function sessionOf(secrets) {
    return String((secrets && secrets.token) || "").trim();
  }

  return {
    id: channel,
    cfg,

    // 模型 id 清单（同步；管理页 / 路由用）：已拉取过目录只认目录（防幽灵模型），未拉取过为空
    // （本家无静态兜底，不编模型名 —— 与别家不同的一点）
    models() {
      return models.list(rules.rulesDir(), channel);
    },

    // 目录条目（含能力 / 倍率元数据），供模型管理与展示
    modelEntries() {
      return models.entries(rules.rulesDir(), channel);
    },

    // 拉取官方目录：GET {模型网关}/models，token + Bearer 双头；拉不到就如实报错（不编模型名）
    async fetchModels(account, secrets, opts) {
      const session = sessionOf(secrets);
      if (!session) return { ok: false, message: "该账号没有凭据" };
      return models.refresh({ session }, rules.rulesDir(), channel, !!(opts && opts.force));
    },

    /** 对话主流程：OpenAI 兼容 SSE，body 原样透传（model 即上游 id，无改写）。
     *  图片适配：deepseek 系模型把 image_url 换成 <image_base64> 文本标记（见 images.cjs）。
     *  缺 session 返回 401。 */
    async chat({ account, secrets, model, body, emit, meta }) {
      const session = sessionOf(secrets);
      if (!session) throw Object.assign(new Error("Loomy 账号缺少 session，无法转发（请重新登录）"), { status: 401 });

      const requestedModel = String((body && body.model) || model || "");
      let payload = body;
      if (images.prefersTagFormat(requestedModel)) {
        const rewritten = images.rewriteToTag(body);
        if (rewritten.converted > 0 && util && typeof util.verbose === "function") {
          util.verbose(`[Loomy] 模型 ${requestedModel} 只认 <image_base64> 标记：已转换 ${rewritten.converted} 个图片块`);
        }
        payload = rewritten.body;
      }

      const c = cfg();
      const base = String(c.modelBase || endpoints.modelBaseUrl()).replace(/\/+$/, "");
      const url = `${base}/chat/completions`;
      const bodyText = JSON.stringify({ ...payload, stream: true });
      const firstByteMs = firstByteBudgetMs(bodyText);

      const { resp, cancelTimer } = await fetchStream(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          token: session,
          Authorization: `Bearer ${session}`,
          Accept: "text/event-stream",
        },
        body: bodyText,
        firstByteMs,
      });

      const result = { status: 200 };
      let settled = false;
      try {
        await pumpSse(resp, (_event, raw) => {
          // 首个 SSE 事件到达 = 首字节达标，立刻解除首字节预算计时器（防长流被误掐，issue #107 同口径）
          if (!settled) { settled = true; cancelTimer(); }
          if (!raw) return;
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          let chunk = null;
          try { chunk = JSON.parse(raw); } catch { return; }
          if (!chunk || typeof chunk !== "object") return;
          const errBody = chunk.error || chunk;
          const errCode = errBody && (errBody.code || errBody.error_code);
          const errMsg = errBody && (errBody.message || errBody.error_msg || errBody.msg);
          const bodyCode = chunk && chunk.code;
          // 业务码 020002 / 100002 是登录态失效（HTTP 200 或非 2xx 的 body 里都可能带）
          if ((errCode && errMsg) || client.isAuthErrorCode(String(bodyCode || ""))) {
            const text = String(errMsg || errCode || bodyCode || "上游返回错误");
            const status = client.isAuthErrorCode(String(bodyCode || "")) ? 401 : 502;
            emit({ type: "error", status, code: errCode || bodyCode, message: text });
            return;
          }
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) {
              emit({ type: "delta", delta: choice.delta });
            }
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (chunk.usage) {
            emit({
              type: "usage",
              usage: {
                ...chunk.usage,
                prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
                completion_tokens: Number(chunk.usage.completion_tokens) || 0,
                total_tokens: Number(chunk.usage.total_tokens) || 0,
              },
            });
          }
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    // 上游错误分类：401/403 或业务码 020002/100002 → TokenExpired；429 → QuotaLimited；其余 → Other
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      const bodyCode = e && e.code;
      if (status === 401 || status === 403 || client.isAuthErrorCode(String(bodyCode || ""))) {
        return { kind: "auth", switchable: false, status: 401 };
      }
      if (status === 429) return { kind: "quota", switchable: true, status: 429 };
      return null;
    },

    // 额度查询：双账户（永久 + 每日赠送），见 balance.cjs
    async queryCredits(account, secrets) {
      const session = sessionOf(secrets);
      if (!session) return { authError: true, message: "Loomy 账号缺少 session" };
      try {
        return await balance.queryBalance({ session });
      } catch (e) {
        if (e && e.authError) return { authError: true, message: e.message };
        return { error: String((e && e.message) || e) };
      }
    },

    // 每日签到 = 每日首次登录刷新赠送积分（按天幂等报成功），见 checkin.cjs
    async checkin(account, secrets) {
      const session = sessionOf(secrets);
      if (!session) return { ok: false, authError: true, message: "Loomy 账号缺少 session" };
      return checkin.checkin({ session });
    },

    // 上游没有「今日是否已签」的查询接口：重复调用按天幂等，故这里只回口径说明，
    // 界面照实写「签到即每日首次登录积分刷新」，不假装查到了状态
    async checkinStatus() {
      return { ok: true, checkedIn: false, message: "Loomy 无独立签到查询接口：签到即每日首次登录积分刷新" };
    },

    // 没有续期（上游无 refresh 接口）：明确返回不可用，账号进入 relogin，界面提示重新短信登录
    async refreshToken() {
      return { ok: false, message: "Loomy 登录态 14 天有效、上游没有续期接口，请重新短信登录" };
    },
  };
}

module.exports = { makeLoomy };
