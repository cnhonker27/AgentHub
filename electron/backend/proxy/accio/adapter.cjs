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
// 反代网关 · Accio 渠道适配器（accio 国际版 / accio_cn 国内版共用工厂）
//
// 上游不是 OpenAI 协议：请求要先转成阿里 ADK 的 Gemini 风格信封（protocol.cjs），
// 响应要拆 ADK 帧（stream.cjs），因此 is_stateful = true 走会话式转发 chatSession。
// 一次客户端请求 = 一次 generateContent 请求 + 协议翻译 + 首帧预读，装得下。
//
// 三个决定性事实（见 endpoints.cjs）：网关两地同一个；client_id 两地逐字相同；token 不走 Authorization 头。
// 会话式转发的关键坑：上游业务错误不体现在 HTTP 状态码上（常是 200 + 帧里的 error_code），因此首帧预读
// 把第一个内容帧拦在返回之前，错误帧转成带状态码的错交回编排层换号（此刻还没下发任何字节，换号无损）；
// 流内中途才冒出来的错误在错误现场发 error 事件（编排层据此冷却/换号）。
//
// 为什么用工厂按渠道参数化（与 qoder/autoclaw 双区同款手法）：两渠道同协议同实现，差别只在
// x-package-region 头与登录站点（regionOf(channel) 给出）。
"use strict";

const crypto = require("node:crypto");
const endpoints = require("./endpoints.cjs");
const protocol = require("./protocol.cjs");
const stream = require("./stream.cjs");
const models = require("./models.cjs");
const auth = require("./auth.cjs");
const oauth = require("./oauth.cjs");
const refreshMod = require("./refresh.cjs");
const balance = require("./balance.cjs");

function makeAccio(channel, deps) {
  const { fetchStream, pumpSse, httpJson, rules, util, firstByteBudgetMs } = deps;
  const cfg = () => (rules.get("headers.json") || {})[channel] || {};
  const region = endpoints.regionOf(channel);

  function tokenOf(secrets) {
    return String((secrets && secrets.token) || "").trim();
  }

  return {
    id: channel,
    cfg,

    /** stateful：本渠道走会话式转发（chatSession），不走单发 chat（见文件头） */
    stateful: () => true,

    // 模型 id 清单（同步；管理页/路由用）：已拉取过目录只认目录（防幽灵模型），未拉取过回静态兜底
    models() {
      return models.list(channel).map((m) => m.id);
    },

    modelEntries() {
      return models.list(channel);
    },

    /** 拉取官方目录：POST /api/llm/config，body {token}，头带 x-package-region。用 v1 不用 v2（v1 更全）。 */
    async fetchModels(account, secrets, opts) {
      const token = tokenOf(secrets);
      if (!token) return { ok: false, message: "该账号没有凭据" };
      return models.refresh(channel, { token }, !!(opts && opts.force));
    },

    /**
     * 会话式转发：构造 Gemini 信封 → 发 generateContent → 首帧预读 → 逐帧翻译下发。
     * 上游 SSE 是标准 data: 帧；[DONE] 收尾。错误帧在首帧预读阶段拦住（换号无损）。
     */
    async chatSession({ account, secrets, model, body, emit, meta }) {
      const token = tokenOf(secrets);
      if (!token) throw Object.assign(new Error("Accio 账号缺少 accessToken，无法转发（请重新登录）"), { status: 401 });

      // 模型名归一：客户端点名 → 上游发送名（upstreamKey）；未知模型如实报错
      const entry = models.resolve(channel, model);
      if (!entry) {
        throw Object.assign(new Error(`Accio 目录里没有模型「${model}」`), { status: 404 });
      }
      const upstreamKey = entry.upstreamKey || entry.id;

      // 思考档位：客户端显式指定优先；否则按账号绑定档位就近收敛到模型声明的档位
      let effort = null;
      const clientLevel = body && (body.reasoning_effort || (body.properties && body.properties.reasoning_effort));
      if (clientLevel && String(clientLevel).toLowerCase() !== "off") {
        effort = protocol.resolveEffort(clientLevel, entry.reasoningEfforts);
      } else {
        const bound = meta && meta.account && meta.account.reasoningEffort;
        if (bound) effort = protocol.resolveEffort(bound, entry.reasoningEfforts);
      }
      const placement = entry.protocolKind === "properties" ? "properties" : "top";

      const { body: upstreamBody, thinking } = protocol.buildUpstreamBody(body || {}, upstreamKey, token, effort, placement);
      const llmBase = String(cfg().llmBase || endpoints.llmBase()).replace(/\/+$/, "");
      const url = protocol.generateContentUrl(llmBase, upstreamBody.request_id);

      const headers = {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-package-region": region.packageRegion,
        appKey: endpoints.appKey(),
        utdid: "",
        version: endpoints.DEFAULT_APP_VERSION,
        "Accept-Language": endpoints.ACCEPT_LANGUAGE,
      };
      const payload = JSON.stringify(upstreamBody);
      const firstByteMs = firstByteBudgetMs(payload);

      const { resp, cancelTimer } = await fetchStream(url, {
        method: "POST",
        headers,
        body: payload,
        firstByteMs,
      });

      const translator = new stream.Translator(`chatcmpl-${crypto.randomBytes(8).toString("hex")}`, String(model || upstreamKey));
      const result = { status: 200 };
      let settled = false;

      // 首帧预读：把第一个内容帧拦在返回之前，错误帧转成带状态码的错（此刻还没下发任何字节，换号无损）
      let firstFrameHandled = false;
      try {
        await pumpSse(resp, (_event, raw) => {
          if (!settled) { settled = true; cancelTimer(); }
          if (!raw) return;
          if (raw === "[DONE]") {
            emit({ type: "finish", reason: translator.finalFinishReason() });
            return;
          }
          const frame = stream.parseFrame(raw);
          if (!frame) return;

          // 首帧预读：第一个帧若是错误帧，抛错交回编排层（还没下发任何字节）
          if (!firstFrameHandled) {
            firstFrameHandled = true;
            if (stream.frameIsError(frame)) {
              const text = stream.frameErrorText(frame);
              const kind = protocol.classifyUpstreamError(200, text);
              const status = kind === "auth" ? 401 : kind === "quota" ? 429 : 502;
              throw Object.assign(new Error(`Accio 上游错误：${text}`), { status, body: text });
            }
          }

          // 流内错误：中途才冒出来的额度/鉴权错误，在错误现场发 error 事件（编排层据此冷却/换号）
          if (stream.frameIsError(frame)) {
            const text = stream.frameErrorText(frame);
            const kind = protocol.classifyUpstreamError(200, text);
            const status = kind === "auth" ? 401 : kind === "quota" ? 429 : 502;
            emit({ type: "error", status, message: text });
            return;
          }

          if (frame.usage) emit({ type: "usage", usage: frame.usage });

          const deltas = translator.consume(frame);
          for (const delta of deltas) {
            if (translator.takeRoleFrame()) {
              emit({ type: "delta", delta: { role: "assistant" } });
            }
            if (delta.kind === "content") {
              emit({ type: "delta", delta: { content: delta.text } });
            } else if (delta.kind === "reasoning") {
              emit({ type: "delta", delta: { reasoning_content: delta.text } });
            } else if (delta.kind === "tool_call") {
              const d = {};
              if (delta.id !== undefined) d.tool_calls = [{ index: delta.index, id: delta.id, type: "function", function: { name: delta.name || "", arguments: "" } }];
              else if (delta.name !== undefined) d.tool_calls = [{ index: delta.index, type: "function", function: { name: delta.name, arguments: "" } }];
              else d.tool_calls = [{ index: delta.index, function: { arguments: delta.arguments || "" } }];
              emit({ type: "delta", delta: d });
            }
          }
          if (frame.turnComplete) {
            emit({ type: "finish", reason: translator.finalFinishReason() });
          }
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    // 防御性报错：Accio 走会话式转发，不走单请求路径
    async chat() {
      throw Object.assign(new Error("Accio 走会话式转发，不走单请求路径（内部错误：编排层未按 stateful 分流）"), { status: 503 });
    },

    // 上游错误分类（扩展点）：401/403 → auth；429 → quota；额度文案 → quota
    classifyError(e) {
      const status = Number(e && e.status) || 0;
      if (status === 401 || status === 403) return { kind: "auth", switchable: false, status: 401 };
      if (status === 429) return { kind: "quota", switchable: true, status: 429 };
      const kind = protocol.classifyUpstreamError(status, (e && e.message) || "");
      if (kind === "quota") return { kind: "quota", switchable: true, status: 429 };
      return null;
    },

    // 额度查询：用量百分比（不是积分），见 balance.cjs
    async queryCredits(account, secrets) {
      const token = tokenOf(secrets);
      if (!token) return { authError: true, message: "Accio 账号缺少 accessToken" };
      try {
        return await balance.queryBalance(channel, { token });
      } catch (e) {
        if (e && e.authError) return { authError: true, message: e.message };
        return { error: String((e && e.message) || e) };
      }
    },

    // 续期：普通 refresh_token 路径，sid/sgcookie 不落库
    async refreshToken(account, secrets) {
      return refreshMod.refreshToken(channel, secrets);
    },

    // 无签到 / 奖励活动：如实回报「不适用」，界面据此不渲染签到入口（与 CatPaw / Cline 同口径）
    async checkin() {
      return { ok: true, unavailable: true, checkedIn: false, message: "Accio 无签到活动，无需操作" };
    },
    async checkinStatus() {
      return { ok: true, unavailable: true, message: "Accio 无签到活动，无需操作" };
    },

    // 登录：OAuth 2.0 授权码 + PKCE（S256），见 oauth.cjs
    async beginOAuth(returnUrl) {
      return oauth.beginLogin(channel, returnUrl);
    },
    async exchangeOAuthCode(code, state) {
      const pending = oauth.takePending(state);
      if (!pending) throw Object.assign(new Error("该回调不属于本应用发起的登录（state 不认识或已过期）"), { status: 400 });
      const creds = await oauth.exchangeCode(channel, code, pending.verifier, pending.redirectUri);
      let identity = { userId: "", name: "", email: "", deviceId: "" };
      try {
        identity = auth.profileIdentity(await auth.fetchProfile(channel, creds.accessToken));
      } catch { /* 拿不到资料不阻断 */ }
      return {
        token: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
        uid: identity.userId || creds.accessToken.slice(0, 12),
        name: identity.name || identity.email || "",
        edition: region.edition,
      };
    },
    async submitCallbackUrl(input) {
      const q = typeof input === "string" ? new URLSearchParams(input.split("?")[1] || "") : new URLSearchParams(input || {});
      const { code, state } = oauth.parseCallback(Object.fromEntries(q.entries()));
      return this.exchangeOAuthCode(code, state);
    },
  };
}

module.exports = { makeAccio };
