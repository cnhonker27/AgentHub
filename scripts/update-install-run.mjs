#!/usr/bin/env node
/**
 * AgentHub —— 检查更新 / 安装依赖 / 运行
 *
 * 一条命令跑完：查远端有没有新提交 → 自动快进拉取 → 按需 npm install → 运行。
 * 交互入口见同目录 update-install-run.cmd（可双击）。
 *
 * 常用参数：
 *   --proxy=http://192.168.0.54:1234    走代理访问 GitHub（只作用于本次 git 命令，
 *                                        不写进仓库或全局 git 配置）
 *   --branch=main                      指定分支（默认：当前分支）
 *   --run=dev                          运行哪个 npm script（默认 dev）
 *   --no-pull / --no-install / --no-run  跳过对应阶段
 *   --install                          无条件执行一次 npm install
 *   --timeout=90                       远端操作超时秒数（默认 90）
 *   --help
 *
 * 代理也可来自环境变量 AGENTHUB_PROXY / HTTPS_PROXY，
 * 或同目录的 update-install-run.proxy.txt（.cmd 双击时会自动读取）。
 *
 * 安全边界：本脚本只做「快进拉取 + 装依赖 + 起服务」，不会 stash / reset /
 * 丢弃你的本地改动，也不会改动 git 配置。遇到分叉或本地改动冲突会停下来提示你。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const RAW = process.argv.slice(2);

const has = (name) => RAW.includes(`--${name}`);
const val = (name, def = null) => {
  const p = `--${name}=`;
  const hit = RAW.find((a) => a.startsWith(p));
  return hit === undefined ? def : hit.slice(p.length);
};

if (has('help') || RAW.includes('-h')) {
  printHelp();
  process.exit(0);
}

const NO_PROXY = has('no-proxy');
const PROXY_FROM = NO_PROXY
  ? ''
  : (() => {
      if (val('proxy') !== null) return '--proxy 参数';
      if (process.env.AGENTHUB_PROXY) return 'AGENTHUB_PROXY 环境变量';
      if (process.env.HTTPS_PROXY || process.env.https_proxy) return 'HTTPS_PROXY 环境变量';
      return '';
    })();
const PROXY = NO_PROXY
  ? ''
  : String(
      val('proxy') ?? process.env.AGENTHUB_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '',
    ).trim();
const BRANCH_ARG = val('branch');
const RUN_SCRIPT = val('run', 'dev');
const TIMEOUT_MS = Math.max(10, Number(val('timeout', '90')) || 90) * 1000;
const DO_PULL = !has('no-pull');
const DO_INSTALL = !has('no-install');
const DO_RUN = !has('no-run');
const FORCE_INSTALL = has('install') || has('force-install');

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

let ROOT = process.cwd();
let SKIPPED_PULL_REASON = '';

// ---------------------------------------------------------------- 输出
function say(m = '') {
  process.stdout.write(`${m}\n`);
}
const stage = (() => {
  let n = 0;
  const total = 2 + (DO_PULL ? 1 : 0) + (DO_INSTALL ? 1 : 0) + (DO_RUN ? 1 : 0);
  return (title) => {
    n += 1;
    say('');
    say(`── [${n}/${total}] ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`);
  };
})();
const info = (m) => say(`      ${m}`);
const ok = (m) => say(`  [OK]  ${m}`);
const warn = (m) => say(`  [!]   ${m}`);

const maskProxy = (u) => u.replace(/\/\/([^/@]+)@/, '//***@');

// ---------------------------------------------------------------- 进程封装
function proxyArgs() {
  return PROXY ? ['-c', `http.proxy=${PROXY}`, '-c', `https.proxy=${PROXY}`] : [];
}

function git(args, { cwd = ROOT, timeout = 0 } = {}) {
  const full = [...proxyArgs(), ...args];
  const r = spawnSync('git', full, {
    cwd,
    encoding: 'utf8',
    timeout: timeout || undefined,
    windowsHide: true,
  });
  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();
  return {
    ok: r.status === 0,
    code: r.status,
    out,
    err,
    timedOut: r.error?.code === 'ETIMEDOUT',
    enoent: r.error?.code === 'ENOENT',
    text: [out, err].filter(Boolean).join('\n'),
  };
}

function npmRun(args) {
  const r = spawnSync(NPM, args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN, windowsHide: false });
  return { ok: r.status === 0, code: r.status, enoent: r.error?.code === 'ENOENT' };
}

function bail(msg, hint) {
  const err = (s) => process.stderr.write(`${s}\n`);
  err(`  [X]   ${msg}`);
  if (hint) {
    err('');
    String(hint)
      .split(/\r?\n/)
      .forEach((l) => err(l));
  }
  process.exit(1);
}

function printHelp() {
  say('');
  say('AgentHub —— 检查更新 / 安装依赖 / 运行');
  say('');
  say('用法： node scripts/update-install-run.mjs [选项]');
  say('');
  say('选项：');
  say('  --proxy=<url>        走代理访问 GitHub，例如 --proxy=http://192.168.0.54:1234');
  say('                      仅作用于本次 git 命令，不写入 git 配置');
  say('  --no-proxy           忽略代理（含 HTTPS_PROXY 等环境变量），强制直连');
  say('  --branch=<name>      目标分支（默认：当前分支）');
  say('  --run=<script>       要运行的 npm script（默认 dev）');
  say('  --no-pull            只检查、不拉取');
  say('  --no-install         跳过 npm install');
  say('  --no-run             更新+安装后不启动');
  say('  --install            无条件执行一次 npm install');
  say('  --timeout=<sec>      远端操作超时（默认 90 秒）');
  say('  -h, --help           显示本帮助');
  say('');
  say('双击运行： update-install-run.cmd');
  say('  代理可写在同目录 update-install-run.proxy.txt（首行有效），.cmd 会自动读取。');
  say('');
}

// ---------------------------------------------------------------- 主流程
function main() {
  // ---------- 1. 环境与仓库 ----------
  stage('环境与仓库检查');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) bail(`Node 版本过低：${process.versions.node}，需要 >= 18`);

  const top = git(['rev-parse', '--show-toplevel']);
  if (top.enoent) bail('未找到 git，请确认已安装 Git 并在 PATH 中');
  if (!top.ok) bail(`当前目录不是 git 仓库：${process.cwd()}`, '请在 AgentHub 仓库内运行本脚本。');
  ROOT = top.out.split(/\r?\n/)[0];

  const branchRaw = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  let branch = BRANCH_ARG || branchRaw;
  if (branch === 'HEAD' && !BRANCH_ARG) {
    warn('当前处于分离头指针（detached HEAD），改用 main');
    branch = 'main';
  }

  const pkgPath = path.join(ROOT, 'package.json');
  let version = '未知';
  if (existsSync(pkgPath)) {
    try {
      version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || '未知';
    } catch {
      /* 忽略解析失败 */
    }
  }

  const headShort = git(['rev-parse', '--short', 'HEAD']).out;
  info(`仓库：   ${ROOT}`);
  info(`分支：   ${branch}`);
  info(`版本：   v${version}  @ ${headShort}`);
  info(`Node：   ${process.versions.node}`);
  if (PROXY) info(`代理：   ${maskProxy(PROXY)}（来源：${PROXY_FROM}；仅本次命令生效，不写入 git 配置）`);
  if (NO_PROXY) info('代理：   已按 --no-proxy 强制直连（忽略环境变量中的代理）');

  const dirty = git(['status', '--porcelain']).out.split(/\r?\n/).filter(Boolean);
  if (dirty.length) {
    warn(`工作区有 ${dirty.length} 项未提交改动（不会动它们）：`);
    dirty.slice(0, 5).forEach((l) => info(`  ${l}`));
    if (dirty.length > 5) info(`  … 其余 ${dirty.length - 5} 项省略`);
  } else {
    ok('工作区干净');
  }

  // ---------- 2. 检查更新 ----------
  stage('检查远端更新');
  info(`git fetch origin ${branch} …`);

  const fetched = git(['fetch', 'origin', branch], { timeout: TIMEOUT_MS });
  if (fetched.timedOut) {
    bail(
      `连接远端超时（${TIMEOUT_MS / 1000}s）`,
      proxyHint(),
    );
  }
  if (!fetched.ok) {
    bail(
      `无法访问远端：${firstLine(fetched.err) || firstLine(fetched.out)}`,
      proxyHint(),
    );
  }
  if (fetched.err) fetched.err.split(/\r?\n/).filter(Boolean).forEach((l) => info(l));

  const remoteTip = git(['rev-parse', 'FETCH_HEAD']).out;
  const localTip = git(['rev-parse', 'HEAD']).out;

  if (!remoteTip) bail('未能解析远端提交（FETCH_HEAD 为空）');

  let incoming = 0;
  let localOnly = 0;
  if (remoteTip !== localTip) {
    incoming = Number(git(['rev-list', '--count', `HEAD..${remoteTip}`]).out || 0);
    localOnly = Number(git(['rev-list', '--count', `${remoteTip}..HEAD`]).out || 0);
  }

  if (incoming === 0 && localOnly === 0) {
    ok(`已是最新（${branch} @ ${localTip.slice(0, 7)}，v${version}）`);
    SKIPPED_PULL_REASON = 'no-update';
  } else if (localOnly > 0) {
    warn(`本地有 ${localOnly} 个远端没有的提交，远端另有 ${incoming} 个新提交 —— 已分叉，跳过自动拉取`);
    info('请手动处理（例如 git pull --rebase，或先备份本地提交），本脚本不替你动历史。');
    SKIPPED_PULL_REASON = 'diverged';
  } else {
    ok(`远端有 ${incoming} 个新提交可拉取`);
    git(['log', '--oneline', '--no-decorate', `HEAD..${remoteTip}`])
      .out.split(/\r?\n/)
      .filter(Boolean)
      .slice(0, 10)
      .forEach((l) => info(`  ${l}`));
    if (incoming > 10) info(`  … 其余 ${incoming - 10} 个提交省略`);
  }

  // ---------- 3. 拉取 ----------
  let pulled = false;
  if (DO_PULL) {
    stage('拉取更新');
    if (SKIPPED_PULL_REASON === 'no-update') {
      ok('无需拉取');
    } else if (SKIPPED_PULL_REASON === 'diverged') {
      warn('已分叉，跳过拉取');
    } else {
      info(`git pull --ff-only origin ${branch} …`);
      const r = git(['pull', '--ff-only', 'origin', branch], { timeout: TIMEOUT_MS });
      if (r.timedOut) {
        bail(`拉取超时（${TIMEOUT_MS / 1000}s）`, proxyHint());
      }
      if (!r.ok) {
        const blob = r.text;
        if (/local changes|would be overwritten|本地修改|未提交/i.test(blob)) {
          bail(
            '拉取被本地未提交改动挡住',
            [
              '  远端修改了你有本地改动的文件，git 拒绝覆盖。',
              '  处理方式（二选一，脚本不替你决定）：',
              '    a) 保留改动： git stash push -m uir  → 再跑一次本脚本 → git stash pop',
              '    b) 放弃改动： git restore <文件>',
              '',
              `  原始错误： ${firstLine(blob)}`,
            ].join('\n'),
          );
        }
        bail(`拉取失败：${firstLine(blob)}`, `  完整输出：\n${indent(blob)}`);
      }
      const newTip = git(['rev-parse', 'HEAD']).out;
      pulled = newTip !== localTip;
      const newVersion = (() => {
        try {
          return JSON.parse(readFileSync(pkgPath, 'utf8')).version || version;
        } catch {
          return version;
        }
      })();
      ok(`已快进到 ${newTip.slice(0, 7)}（v${newVersion}）`);
      version = newVersion;
    }
  }

  // ---------- 4. 安装依赖 ----------
  let installed = false;
  if (DO_INSTALL) {
    stage('安装依赖');
    const reason = installReason(localTip, pulled);
    if (reason) {
      info(`执行 npm install（原因：${reason}）…`);
      const r = npmRun(['install']);
      if (r.enoent) bail('未找到 npm，请确认 Node.js 已正确安装');
      if (!r.ok) bail(`npm install 失败（退出码 ${r.code}）`);
      installed = true;
      ok('依赖已就绪');
    } else {
      ok('node_modules 已存在，且依赖清单无变更，跳过安装');
    }
  }

  // ---------- 5. 运行 ----------
  if (DO_RUN) {
    stage(`运行 npm run ${RUN_SCRIPT}`);
    info('按 Ctrl+C 结束');
    say('');
    const child = spawn(NPM, ['run', RUN_SCRIPT], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WIN,
      windowsHide: false,
    });
    child.on('error', (e) => bail(`启动失败：${e.message}`));
    child.on('exit', (code) => {
      say('');
      if (code === 0) say(`  运行结束（npm run ${RUN_SCRIPT} 正常退出）`);
      else warn(`npm run ${RUN_SCRIPT} 退出码：${code}`);
      process.exit(code ?? 0);
    });
    return;
  }

  // ---------- 小结 ----------
  say('');
  say('── 小结 ──────────────────────────────────────────────');
  info(`提交：   ${localTip.slice(0, 7)} → ${git(['rev-parse', '--short', 'HEAD']).out}`);
  info(`版本：   v${version}`);
  const pullText = pulled
    ? '已快进'
    : SKIPPED_PULL_REASON === 'diverged'
      ? '已分叉，跳过'
      : incoming > 0
        ? `未拉取（远端有 ${incoming} 个新提交）`
        : '无需拉取';
  info(`拉取：   ${pullText}`);
  info(`依赖：   ${installed ? '已安装' : DO_INSTALL ? '无需安装' : '已跳过'}`);
  info(`运行：   ${DO_RUN ? `npm run ${RUN_SCRIPT}` : '已跳过'}`);
  say('');
}

function installReason(oldTip, pulled) {
  if (FORCE_INSTALL) return '显式指定 --install';
  if (!existsSync(path.join(ROOT, 'node_modules'))) return 'node_modules 不存在';
  if (!pulled) return null;
  const newTip = git(['rev-parse', 'HEAD']).out;
  const changed = git(['diff', '--name-only', oldTip, newTip]).out.split(/\r?\n/).filter(Boolean);
  if (changed.includes('package.json') || changed.includes('package-lock.json')) return '依赖清单有变更';
  return null;
}

function proxyHint() {
  if (PROXY) {
    return [
      `  已通过代理 ${maskProxy(PROXY)}（来源：${PROXY_FROM}）访问远端，仍然失败。`,
      '  可依次排查：',
      '    1) 代理是否还活着（浏览器能否打开 github.com），端口/地址是否变了',
      '    2) 换一个代理重试： --proxy=http://<host>:<port>',
      '    3) 绕过代理直连试一次： --no-proxy',
    ].join('\n');
  }
  return [
    '  直连 GitHub 可能被拦（典型报错：CONNECT tunnel failed / response 502、schannel handshake failed）。',
    '  加代理重试，例如：',
    '    node scripts/update-install-run.mjs --proxy=http://192.168.0.54:1234',
    '  或把代理地址写进 scripts/update-install-run.proxy.txt（双击 .cmd 时会自动读取）。',
  ].join('\n');
}

const firstLine = (s) =>
  String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0] || '';

const indent = (s) => String(s || '').split(/\r?\n/).map((l) => `    ${l}`).join('\n');

main();
