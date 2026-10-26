/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Antigravity（旧版）数据源适配器
// 用量来源：~/.gemini/antigravity/conversations/*.db（gen_metadata 逐次生成计数）
// 设备标识：~/.gemini/antigravity/antigravity_state.pbtxt 的 installation_uuid
// 统计口径与解析细节见 adapter-antigravity-common.cjs
"use strict";
const { makeAdapter } = require("./adapter-antigravity-common.cjs");

module.exports = makeAdapter("antigravity", "Antigravity", "antigravity");
