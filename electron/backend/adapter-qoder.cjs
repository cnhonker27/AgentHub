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
// Qoder 数据源适配器（国际版）
// 用量来源：~/.qoder/projects/**/*.jsonl 会话转录，统计口径见 adapter-qoder-common.cjs
"use strict";
const { makeQoderAdapter } = require("./adapter-qoder-common.cjs");

module.exports = makeQoderAdapter("qoder", "Qoder", ".qoder", "QODER_DATA_HOME");
