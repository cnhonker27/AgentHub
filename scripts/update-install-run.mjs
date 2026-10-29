#!/usr/bin/env node
/**
 * AgentHub —— 同步上游 / 安装依赖 / 运行
 *
 * 一条命令跑完：把上游最新代码合并到当前分支 → 按需 npm install → 运行。
 * 交互入口见同目录 update-install-run.cmd（可双击）。
 *
 * 同步策略：默认从 remote=upstream 取 branch=main，再用 git merge 合并到
 * 「当前所在分支」（脚本绝不切换分支），所以你本分支自己的提交会被保留。
 *
 * 容错策略：
 *   - 拉不到上游（离线 / 超时 / remote 不存在）→ 打印醒目提示，直接用本地现有版本启动；
 *     加 --strict-update 可改成「拉取失败即中止」。
 *   - 合并冲突、或本地未提交改动挡路 → 停下并提示怎么处理，不自动解决、不启动
 *     （工作区处于合并中间态，启动没有意义）。
 *
 * 常用参数：
 *   --remote=upstream                  从哪个 remote 取上游（默认 upstream）
 *   --branch=main                      取上游的哪个分支（默认 main）
 *   --proxy=http://192.168.0.54:1234   走代理访问 GitHub（只作用于本次 git 命令，
 *                                      不写进仓库或全局 git 配置）
 *   --run=dev                          运行哪个 npm script（默认 dev）
 *   --no-pull / --no-install / --no-run  跳过对应阶段
 *   --install                          无条件执行一次 npm install
 *   --strict-update                    拉取失败时中止，而不是降级继续启动
 *   --timeout=90                       远端操作超时秒数（默认 90）
 *   --dev-port=1420                    启动前检查哪个端口（默认从 npm script 的
 *                                      wait-on tcp:<port> / vite.config 里自动识别）
 *   --no-port-check                    不检查端口占用，直接启动
 *   --force-port                       端口被占时强制结束占用者
 *   --help
 *
 * 代理也可来自环境变量 AGENTHUB_PROXY / HTTPS_PROXY，
 * 或同目录的 update-install-run.proxy.txt（.cmd 双击时会自动读取）。
 *
 * 安全边界：本脚本只做「合并上游 + 装依赖 + 起服务」，不会 stash / reset /
 * force、不自动解冲突、不切换分支、不改 git 配置。
 * 唯一的例外是端口清理：启动前若发现目标端口被「本仓库自己遗留的」进程占着
 * （上一次 dev 被强杀后 vite 变成孤儿是常见现象），会结束它再启动；
 * 不属于本仓库的进程一律不动、只报错。--no-port-check 可整体关闭该行为。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
const UPSTREAM_REMOTE = val('remote', 'upstream');
const UPSTREAM_BRANCH = val('branch', 'main');
const RUN_SCRIPT = val('run', 'dev');
const TIMEOUT_MS = Math.max(10, Number(val('timeout', '90')) || 90) * 1000;
const DO_PULL = !has('no-pull');
const DO_INSTALL = !has('no-install');
const DO_RUN = !has('no-run');
const FORCE_INSTALL = has('install') || has('force-install');
// 启动前检查端口占用：默认开，--no-port-check 关
const NO_PORT_CHECK = has('no-port-check');
const DEV_PORT_OVERRIDE = val('dev-port');
const FORCE_PORT = has('force-port');
// 默认容错：更新失败不阻塞启动；加 --strict-update 恢复「失败即中止」
const STRICT_UPDATE = has('strict-update');

const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

let ROOT = process.cwd();
let SKIPPED_PULL_REASON = '';

// ---------------------------------------------------------------- 输出
function say(m = '') {
  process.stdout.write(`${m}\n`);
}
const stageState = {
  n: 0,
  total: 2 + (DO_PULL ? 1 : 0) + (DO_INSTALL ? 1 : 0) + (DO_RUN ? 1 : 0),
};
function stage(title) {
  stageState.n += 1;
  say('');
  say(`── [${stageState.n}/${stageState.total}] ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`);
}
// 更新整体不可用（无 git / 非 git 仓库）时，把「检查远端更新」「拉取更新」两个阶段从计数里扣掉
function dropStages(k) {
  stageState.total = Math.max(stageState.n, stageState.total - k);
}
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
  say('AgentHub —— 同步上游 / 安装依赖 / 运行');
  say('');
  say('用法： node scripts/update-install-run.mjs [选项]');
  say('');
  say('选项：');
  say('  --remote=<name>      从哪个 remote 取上游（默认 upstream）');
  say('  --branch=<name>      取上游的哪个分支（默认 main）');
  say('  --proxy=<url>        走代理访问 GitHub，例如 --proxy=http://192.168.0.54:1234');
  say('                      仅作用于本次 git 命令，不写入 git 配置');
  say('  --no-proxy           忽略代理（含 HTTPS_PROXY 等环境变量），强制直连');
  say('  --run=<script>       要运行的 npm script（默认 dev）');
  say('  --no-pull            只检查、不合并');
  say('  --no-install         跳过 npm install');
  say('  --no-run             合并+安装后不启动');
  say('  --install            无条件执行一次 npm install');
  say('  --strict-update      拉取失败时中止，而不是降级继续启动');
  say('  --timeout=<sec>      远端操作超时（默认 90 秒）');
  say('  --dev-port=<port>    启动前检查哪个端口（默认自动识别）');
  say('  --no-port-check      不检查端口占用，直接启动');
  say('  --force-port         端口被占时强制结束占用者（确认是自己的进程再用）');
  say('  -h, --help           显示本帮助');
  say('');
  say('上游代码用 git merge 合并到「当前所在分支」，不会切换分支、不会丢弃你的提交；');
  say('遇到冲突会停下并提示你手动解决。');
  say('');
  say('启动前会检查 dev 端口：上次启动残留的进程（如被强杀后变孤儿的 vite）占着时');
  say('会自动结束它——靠 .git/uir-dev.lock 记录 PID 自证身份；认不出的只报错不动手。');
  say('');
  say('双击运行： update-install-run.cmd');
  say('  代理可写在同目录 update-install-run.proxy.txt（首行有效），.cmd 会自动读取。');
  say('');
}

// ---------------------------------------------------------------- 端口占用
// dev 脚本靠 `wait-on tcp:<port>` 等 vite 起来。上一次 dev 若不是 Ctrl+C 正常退出，
// vite 会变成孤儿继续监听，下次启动就撞上 "Port 1420 is already in use"，
// 而 wait-on 等不到端口、electron 也跟着退出，现象是「莫名其妙启动失败」。
// 启动前先把「本仓库自己遗留的」监听进程收掉；别人的进程一律不动、只报错。
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function npmScriptOf(name) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return (pkg.scripts && pkg.scripts[name]) || '';
  } catch {
    return '';
  }
}

// 端口来源优先级：--dev-port 参数 > npm script 里的 tcp:<port> > vite.config 的 port
function devPortFor(scriptName) {
  if (DEV_PORT_OVERRIDE) {
    const n = Number(DEV_PORT_OVERRIDE);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  }
  const cmd = npmScriptOf(scriptName);
  const m = cmd.match(/tcp:(\d+)/);
  if (m) return Number(m[1]);
  if (/\bvite\b/.test(cmd)) {
    try {
      const cfg = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
      const p = cfg.match(/\bport:\s*(\d+)/);
      if (p) return Number(p[1]);
    } catch {
      /* 没有 vite.config 就算了 */
    }
  }
  return null;
}

// 返回监听该端口的 PID 列表；非 Windows 返回 null 表示不支持（跳过检查）
// 注意：不能用 netstat -p TCP —— 它只列 IPv4，而 vite 默认监听 [::1]:1420，
// 加了过滤条件会把真实的占用看漏（会误报「端口空闲」）。
function listeningPids(port) {
  if (!IS_WIN) return null;
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return [];
  const pids = new Set();
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!/^\s*TCP/i.test(line) || !/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    // 本地地址列形如 0.0.0.0:1420 / 127.0.0.1:1420 / [::1]:1420 / [::]:1420
    if (!cols[1] || !cols[1].endsWith(`:${port}`)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

// 进程归属怎么判断：本机没有 powershell/wmic 可用（取不到命令行），所以改用
// 「锁文件」自证身份——启动成功后把监听者 PID 写进 .git/uir-dev.lock，
// 下次启动时 PID 对得上才认定是自己上次的残留，可以对得上才动手。
function devLockPath() {
  return path.join(ROOT, '.git', 'uir-dev.lock');
}

function readDevLock() {
  try {
    const j = JSON.parse(readFileSync(devLockPath(), 'utf8'));
    return j && Array.isArray(j.pids) ? j : null;
  } catch {
    return null;
  }
}

function writeDevLock(port, pids) {
  try {
    writeFileSync(devLockPath(), JSON.stringify({ port, pids, startedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* .git 不可写就放弃记录，不影响启动 */
  }
}

function clearDevLock() {
  try {
    if (existsSync(devLockPath())) unlinkSync(devLockPath());
  } catch {
    /* 忽略 */
  }
}

// 端口被占时的收尾：先看锁文件认不认得出「自己人」，认得出才结束；
// 否则只报错不动手（--force-port 可显式要求强杀）
function ensurePortFree(port) {
  const pids = listeningPids(port);
  if (pids === null) return; // 非 Windows：跳过
  if (!pids.length) {
    ok(`端口 ${port} 空闲`);
    return;
  }

  const lock = readDevLock();
  const claimed = lock && lock.port === port ? new Set(lock.pids) : null;
  const isOurs = !!claimed && pids.every((pid) => claimed.has(pid));

  if (!isOurs && !FORCE_PORT) {
    bail(
      `端口 ${port} 已被占用，已停止启动（未结束任何进程）`,
      [
        '  占用者不属于「本脚本上一次启动的进程」（锁文件对不上/不存在），所以不替你结束它：',
        ...pids.map((pid) => `    PID ${pid}`),
        '  常见原因：另开了一个终端在跑 dev、或本仓库的旧进程被杀后没留下锁文件。',
        '',
        '  处理方式（任选其一）：',
        '    确认是自家进程后强制结束并继续： --force-port',
        `    手动结束： taskkill /T /F /PID ${pids[0]}`,
        '    换个端口： --dev-port=<port>',
        '    跳过检查： --no-port-check',
      ].join('\n'),
    );
  }

  const why = isOurs ? '本脚本上一次启动后残留' : '按 --force-port 要求';
  warn(`端口 ${port} 被占用（PID ${pids.join(', ')}，判定：${why}），正在结束…`);
  for (const pid of pids) {
    info(`结束 PID ${pid}`);
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  }
  clearDevLock();

  // 等系统回收监听套接字，最多 5 秒
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!listeningPids(port).length) {
      ok(`端口 ${port} 已释放`);
      return;
    }
    sleepSync(200);
  }
  bail(
    `端口 ${port} 仍然被占用，无法启动`,
    '  可能是权限不足（进程属于管理员）或刚结束的进程还在退出中。\n' +
      '  请稍等再试，或以管理员身份运行；也可先 --no-port-check 观察是否另有原因。',
  );
}

// 起来之后把真正的监听者 PID 记进锁文件，供下一次启动辨认
function rememberDevListener(port, onDone) {
  const deadline = Date.now() + 20000;
  const tick = () => {
    const pids = listeningPids(port);
    if (pids && pids.length) {
      writeDevLock(port, pids);
      info(`已记录 dev 监听进程（PID ${pids.join(', ')}），下次启动可自动清残留`);
      return;
    }
    if (Date.now() > deadline) return;
    setTimeout(tick, 300).unref?.();
  };
  setTimeout(tick, 300).unref?.();
  if (onDone) onDone();
}

// ---------------------------------------------------------------- 主流程
function main() {
  // ---------- 1. 环境与仓库 ----------
  stage('环境与仓库检查');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) bail(`Node 版本过低：${process.versions.node}，需要 >= 18`);

  // 更新失败（没网、超时、拉不动、没装 git…）不该阻塞启动：这类问题一律降级为警告，
  // 用本地现有版本继续跑；--strict-update 可恢复「失败即中止」。
  let UPDATE_DISABLED = '';
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.enoent) {
    UPDATE_DISABLED = '未找到 git，无法检查更新';
  } else if (!top.ok) {
    UPDATE_DISABLED = `当前目录不是 git 仓库（${process.cwd()}）`;
  } else {
    ROOT = top.out.split(/\r?\n/)[0];
  }

  // 合并目标恒为「当前所在分支」——脚本绝不切换分支。分离头指针下没有当前分支可言，
  // 直接停下说明白，别让用户以为合到哪儿去了。
  let currentBranch = '';
  if (!UPDATE_DISABLED) {
    currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
    if (currentBranch === 'HEAD') {
      bail(
        '当前处于分离头指针（detached HEAD），没有可合并的当前分支',
        '  请先切到一个分支（例如 git switch upstream-run）再跑本脚本。',
      );
    }
    // 上一次合并没收尾就再跑：停在冲突中间态上装依赖、起服务没有意义。
    if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
      bail(
        '检测到上一次的合并尚未完成（仓库处于 merge 中间态）',
        [
          '  先把上次的合并处理掉，再跑本脚本：',
          '    解决冲突后  git add <文件>  &&  git merge --continue',
          '    放弃这次合并  git merge --abort',
        ].join('\n'),
      );
    }
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
  let localTip = headShort || 'unknown';
  let incoming = 0;
  let localOnly = 0;
  info(`仓库：   ${ROOT}`);
  info(`当前分支： ${currentBranch || '未知'}`);
  info(`上游：   ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`);
  info(`版本：   v${version}  @ ${headShort || '未知'}`);
  info(`Node：   ${process.versions.node}`);
  if (PROXY) info(`代理：   ${maskProxy(PROXY)}（来源：${PROXY_FROM}；仅本次命令生效，不写入 git 配置）`);
  if (NO_PROXY) info('代理：   已按 --no-proxy 强制直连（忽略环境变量中的代理）');

  if (UPDATE_DISABLED) {
    warn(`${UPDATE_DISABLED} —— 跳过更新，直接启动本地版本`);
  } else {
    const dirty = git(['status', '--porcelain']).out.split(/\r?\n/).filter(Boolean);
    if (dirty.length) {
      warn(`工作区有 ${dirty.length} 项未提交改动（不会动它们）：`);
      dirty.slice(0, 5).forEach((l) => info(`  ${l}`));
      if (dirty.length > 5) info(`  … 其余 ${dirty.length - 5} 项省略`);
    } else {
      ok('工作区干净');
    }
  }

  // ---------- 2. 检查上游更新 ----------
  if (UPDATE_DISABLED) {
    if (STRICT_UPDATE) bail(UPDATE_DISABLED, '  --strict-update 模式：更新不可用即中止。去掉该参数可跳过更新、直接启动本地版本。');
    dropStages(1 + (DO_PULL ? 1 : 0));
  } else {
    stage('检查上游更新');
    info(`git fetch ${UPSTREAM_REMOTE} ${UPSTREAM_BRANCH} …`);

    const fetched = git(['fetch', UPSTREAM_REMOTE, UPSTREAM_BRANCH], { timeout: TIMEOUT_MS });
    if (fetched.timedOut || !fetched.ok) {
      const why = fetched.timedOut
        ? `连接上游超时（${TIMEOUT_MS / 1000}s）`
        : `无法访问上游：${firstLine(fetched.err) || firstLine(fetched.out)}`;
      if (STRICT_UPDATE) bail(why, proxyHint());
      warn(`${why} —— 拉不到上游不影响启动，将直接用本地现有版本运行`);
      proxyHint().split(/\r?\n/).forEach((l) => info(l));
      SKIPPED_PULL_REASON = 'fetch-failed';
    } else {
      if (fetched.err) fetched.err.split(/\r?\n/).filter(Boolean).forEach((l) => info(l));

      const remoteRef = `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`;
      const remoteTip = git(['rev-parse', remoteRef]).out;
      localTip = git(['rev-parse', 'HEAD']).out;

      if (!remoteTip) {
        if (STRICT_UPDATE) bail(`未能解析上游提交（${remoteRef} 为空）`);
        warn(`未能解析上游提交（${remoteRef} 为空）—— 跳过合并，继续启动`);
        SKIPPED_PULL_REASON = 'fetch-failed';
      } else {
        incoming = Number(git(['rev-list', '--count', `HEAD..${remoteRef}`]).out || 0);
        localOnly = Number(git(['rev-list', '--count', `${remoteRef}..HEAD`]).out || 0);

        if (incoming === 0) {
          ok(`已是最新（${remoteRef} @ ${localTip.slice(0, 7)}，v${version}）`);
          SKIPPED_PULL_REASON = 'no-update';
        } else {
          // 本分支有自己的提交也没关系：用 merge 合进来，本地提交会被保留。
          ok(`上游有 ${incoming} 个新提交待合并（本分支另有 ${localOnly} 个提交会保留）`);
          git(['log', '--oneline', '--no-decorate', `HEAD..${remoteRef}`])
            .out.split(/\r?\n/)
            .filter(Boolean)
            .slice(0, 10)
            .forEach((l) => info(`  ${l}`));
          if (incoming > 10) info(`  … 其余 ${incoming - 10} 个提交省略`);
        }
      }
    }
  }

  // ---------- 3. 合并上游到当前分支 ----------
  let merged = false;
  if (DO_PULL) {
    stage(`合并上游到当前分支（${currentBranch || '当前分支'}）`);
    if (SKIPPED_PULL_REASON === 'no-update') {
      ok('无需合并');
    } else if (SKIPPED_PULL_REASON === 'fetch-failed') {
      warn('拉取上游失败，跳过合并（不影响启动）');
    } else {
      const remoteRef = `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`;
      info(`git merge --no-edit ${remoteRef} …`);
      const r = git(['merge', '--no-edit', remoteRef], { timeout: TIMEOUT_MS });

      // 冲突优先判定：仓库已进入 merge 中间态，交给用户手动收尾，脚本只提示、不动手。
      if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
        const files = conflictFiles();
        bail(
          `合并 ${remoteRef} 时发生冲突，已停下`,
          [
            '  仓库停在合并中间态，等你手动解决（脚本不会替你解，也不会丢弃任何一方）：',
            '    git status                              查看冲突文件',
            '    编辑冲突文件后  git add <文件>  &&  git merge --continue',
            '    或者放弃这次合并  git merge --abort',
            files.length ? `\n  冲突文件：\n${files.map((f) => `    ${f}`).join('\n')}` : '',
          ].join('\n'),
        );
      }

      if (!r.ok) {
        const blob = r.text;
        if (/local changes|would be overwritten|本地修改|未提交/i.test(blob)) {
          bail(
            '合并被本地未提交改动挡住',
            [
              '  上游改了你本地也改过、且尚未提交的文件，git 拒绝覆盖（脚本不替你 stash）。',
              '  处理方式（二选一，你自己决定）：',
              '    a) 保留改动： git stash push -m uir  → 再跑一次本脚本 → git stash pop',
              '    b) 放弃改动： git restore <文件>',
              '',
              `  原始错误： ${firstLine(blob)}`,
            ].join('\n'),
          );
        }
        bail(`合并失败：${firstLine(blob)}`, `  完整输出：\n${indent(blob)}`);
      }

      const newTip = git(['rev-parse', 'HEAD']).out;
      merged = newTip !== localTip;
      const newVersion = (() => {
        try {
          return JSON.parse(readFileSync(pkgPath, 'utf8')).version || version;
        } catch {
          return version;
        }
      })();
      ok(merged ? `已合并到 ${newTip.slice(0, 7)}（v${newVersion}）` : `已在最新（${newTip.slice(0, 7)}，v${newVersion}）`);
      version = newVersion;
    }
  }

  // ---------- 4. 安装依赖 ----------
  let installed = false;
  if (DO_INSTALL) {
    stage('安装依赖');
    const reason = installReason(localTip, merged);
    if (reason) {
      info(`执行 npm install（原因：${reason}）…`);
      const r = npmRun(['install']);
      if (r.enoent) bail('未找到 npm，请确认 Node.js 已正确安装');
      if (!r.ok) {
        if (!existsSync(path.join(ROOT, 'node_modules'))) {
          bail(
            `npm install 失败（退出码 ${r.code}），且 node_modules 不存在，无法启动`,
            '  请修复网络/代理后重试，或手动执行一次 npm install。',
          );
        }
        warn(`npm install 失败（退出码 ${r.code}）—— 依赖可能不完整，仍尝试用现有 node_modules 启动`);
      } else {
        installed = true;
        ok('依赖已就绪');
      }
    } else {
      ok('node_modules 已存在，且依赖清单无变更，跳过安装');
    }
  }

  // ---------- 5. 运行 ----------
  if (DO_RUN) {
    stage(`运行 npm run ${RUN_SCRIPT}`);
    if (UPDATE_DISABLED || SKIPPED_PULL_REASON === 'fetch-failed') {
      info('注意：本次未拉到上游更新，启动的是本地现有版本');
    }
    const devPort = NO_PORT_CHECK ? null : devPortFor(RUN_SCRIPT);
    if (devPort) ensurePortFree(devPort);
    info('按 Ctrl+C 结束');
    say('');
    const child = spawn(NPM, ['run', RUN_SCRIPT], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: IS_WIN,
      windowsHide: false,
    });
    child.on('error', (e) => bail(`启动失败：${e.message}`));
    if (devPort) rememberDevListener(devPort);
    child.on('exit', (code) => {
      if (devPort) clearDevLock();
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
  const headNow = git(['rev-parse', '--short', 'HEAD']).out || '未知';
  info(`提交：   ${(localTip || '未知').slice(0, 7)} → ${headNow}`);
  info(`版本：   v${version}`);
  const pullText = UPDATE_DISABLED
    ? 'git 不可用，已跳过'
    : merged
      ? `已把 ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} 合并到 ${currentBranch || '当前分支'}`
      : SKIPPED_PULL_REASON === 'fetch-failed'
        ? '拉取失败，已跳过（不影响启动）'
        : incoming > 0
          ? `未合并（上游有 ${incoming} 个新提交）`
          : '无需合并';
  info(`同步：   ${pullText}`);
  info(`依赖：   ${installed ? '已安装' : DO_INSTALL ? '无需安装' : '已跳过'}`);
  info(`运行：   ${DO_RUN ? `npm run ${RUN_SCRIPT}` : '已跳过'}`);
  say('');
}

function conflictFiles() {
  return git(['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
}

function installReason(oldTip, merged) {
  if (FORCE_INSTALL) return '显式指定 --install';
  if (!existsSync(path.join(ROOT, 'node_modules'))) return 'node_modules 不存在';
  if (!merged) return null;
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
