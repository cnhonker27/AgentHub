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
// TRAE SOLO CN 数据源适配器
// 用量来源：%APPDATA%\TRAE SOLO CN\ModularData\ai-agent\database.db（SQLCipher，chat_turn.context.token_usage）
// 统计口径与解密细节见 adapter-trae-common.cjs
"use strict";
const { makeTraeAdapter } = require("./adapter-trae-common.cjs");

module.exports = makeTraeAdapter("trae-solo-cn", "TRAE SOLO CN", "TRAE SOLO CN", "TRAESOLOCN_DATA_HOME");
