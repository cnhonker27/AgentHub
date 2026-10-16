// update-install-run：同步上游 / 合并 / 冲突 / 离线 行为沙箱自测
// 运行：node scripts/test-update-install-run.cjs
//
// 全程只在临时目录里演练本地 git（upstream 是本地仓库，不联网），
// npm 阶段用 --no-install 跳过装依赖，运行阶段用假的 dev 脚本打标记。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "update-install-run.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ah-uir-test-"));

const GIT_ENV = {
  ...process.env,
  GIT_MERGE_AUTOEDIT: "no", // 合并提交不弹编辑器
  GIT_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0", // 绝不停下来等输入
};

let pass = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, env: GIT_ENV });
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();
  return { ok: r.status === 0, code: r.status, out, err, text: [out, err].filter(Boolean).join("\n") };
}

function runScript(cwd, args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: GIT_ENV,
    timeout: 120000,
  });
  const out = r.stdout || "";
  const err = r.stderr || "";
  return { code: r.status, out, err, all: `${out}${err}` };
}

// 造沙箱：upstream 是「上游仓库」，work 是从它 clone 出来的「本地副本」。
// 两端共享同一个初始提交（工作区干净），所以默认场景可以真快进。
function scenario(name, { renameToUpstream = true } = {}) {
  const dir = path.join(TMP, `s-${name}`);
  fs.mkdirSync(dir, { recursive: true });

  const upstream = path.join(dir, "upstream");
  fs.mkdirSync(upstream);
  git(upstream, ["init", "-b", "main"]);
  git(upstream, ["config", "user.email", "t@example.com"]);
  git(upstream, ["config", "user.name", "tester"]);
  fs.writeFileSync(path.join(upstream, "README.md"), "v1\n");
  // npm run dev 的假实现：只打一个可断言的标记
  fs.writeFileSync(path.join(upstream, "run-marker.cjs"), "console.log('<<RAN>>');\n");
  fs.writeFileSync(
    path.join(upstream, "package.json"),
    JSON.stringify({ name: "sandbox", version: "0.0.0", scripts: { dev: "node run-marker.cjs" } }, null, 2),
  );
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "init"]);

  const work = path.join(dir, "work");
  git(dir, ["clone", "-q", upstream, work]);
  git(work, ["config", "user.email", "t@example.com"]);
  git(work, ["config", "user.name", "tester"]);
  if (renameToUpstream) git(work, ["remote", "rename", "origin", "upstream"]);

  return { dir, upstream, work };
}

function upstreamCommit(upstream, file, content, msg) {
  fs.writeFileSync(path.join(upstream, file), content);
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", msg]);
  return git(upstream, ["rev-parse", "HEAD"]).out;
}

const commitSubjects = (repo) => git(repo, ["log", "--format=%s"]).out.split(/\r?\n/).filter(Boolean);

// ① 默认从上游合并（快进）
console.log("① 默认 remote=upstream：合并上游新增");
{
  const { upstream, work } = scenario("ff");
  const upstreamHead = upstreamCommit(upstream, "app.txt", "new upstream code\n", "upstream adds app.txt");
  const r = runScript(work, ["--no-install"]);
  ok(fs.existsSync(path.join(work, "app.txt")), "上游新文件已并入本地");
  ok(git(work, ["rev-parse", "HEAD"]).out === upstreamHead, "本地 HEAD 快进到上游 HEAD");
  ok(r.code === 0 && r.all.includes("<<RAN>>"), "合并后照常启动（退出码 0）");
}

// ② 本分支有本地提交：保留本地提交，同时并入上游
console.log("② 本地有提交：合并而非覆盖");
{
  const { upstream, work } = scenario("keep-local");
  fs.writeFileSync(path.join(work, "mine.txt"), "mine\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "my local work"]);
  upstreamCommit(upstream, "app.txt", "upstream\n", "upstream adds app.txt");
  const r = runScript(work, ["--no-install"]);
  ok(commitSubjects(work).includes("my local work"), "本地提交仍在历史里");
  ok(fs.existsSync(path.join(work, "app.txt")), "上游改动也已并入");
  ok(r.code === 0 && r.all.includes("<<RAN>>"), "合并后照常启动");
}

// ③ 冲突：明确提示、停下、不启动，且停在 merge 中等人处理
console.log("③ 冲突：提示 + 停下 + 不启动");
{
  const { upstream, work } = scenario("conflict");
  fs.writeFileSync(path.join(work, "README.md"), "work version\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "local edit"]);
  upstreamCommit(upstream, "README.md", "upstream version\n", "upstream edit");
  const r = runScript(work, ["--no-install"]);
  ok(r.code !== 0, "冲突时退出码非 0");
  ok(git(work, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok, "停在 merge 中，等用户手动解决");
  ok(!r.all.includes("<<RAN>>"), "冲突时不启动");
  ok(/冲突|conflict/i.test(r.all), "明确提示冲突");
}

// ④ 拉不到上游（离线/地址不可达）：提示，但直接启动本地版本
console.log("④ 拉不到上游：提示 + 直接启动");
{
  const { work, dir } = scenario("offline");
  git(work, ["remote", "set-url", "upstream", path.join(dir, "nope-does-not-exist")]);
  const r = runScript(work, ["--no-install"]);
  ok(r.code === 0, "拉不到上游仍退出码 0");
  ok(r.all.includes("<<RAN>>"), "拉不到上游仍直接启动本地版本");
  ok(/拉|更新|上游|upstream/i.test(r.all), "对拉取失败有提示");
}

// ⑤ 未提交改动挡路：停下提示、不启动、且不进入 merge 状态（不擅自动用户的改动）
console.log("⑤ 未提交改动挡路：停下提示、不启动");
{
  const { upstream, work } = scenario("dirty");
  upstreamCommit(upstream, "README.md", "upstream changed readme\n", "upstream edit");
  fs.writeFileSync(path.join(work, "README.md"), "my uncommitted edit\n");
  const r = runScript(work, ["--no-install"]);
  ok(r.code !== 0, "被未提交改动挡住时退出码非 0");
  ok(!r.all.includes("<<RAN>>"), "被挡住时不启动");
  ok(!git(work, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok, "不进入 merge 状态");
}

// ⑥ 本地脚本文件在上游中没有：合并后必须还在（不能把自己删掉）
console.log("⑥ 本地文件不在上游：合并后仍在");
{
  const { upstream, work } = scenario("script-survives");
  fs.mkdirSync(path.join(work, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(work, "scripts", "update-install-run.mjs"), "// local script\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-m", "add local script"]);
  upstreamCommit(upstream, "app2.txt", "x\n", "upstream adds app2.txt");
  const r = runScript(work, ["--no-install"]);
  ok(fs.existsSync(path.join(work, "scripts", "update-install-run.mjs")), "合并上游后本地脚本文件还在");
  ok(r.code === 0 && r.all.includes("<<RAN>>"), "合并后照常启动");
}

// ⑦ --remote 覆盖：默认之外的 remote 也能用
console.log("⑦ --remote=origin 覆盖默认");
{
  const { upstream, work } = scenario("remote-override", { renameToUpstream: false }); // 保留 origin
  upstreamCommit(upstream, "app3.txt", "x\n", "upstream adds app3.txt");
  const r = runScript(work, ["--no-install", "--remote=origin"]);
  ok(fs.existsSync(path.join(work, "app3.txt")), "--remote=origin 生效（拉到 origin）");
  ok(r.code === 0, "退出码 0");
}

// ⑧ --branch 覆盖：默认 main 之外的上游分支
console.log("⑧ --branch=release 覆盖默认分支");
{
  const { upstream, work } = scenario("branch-override");
  git(upstream, ["checkout", "-q", "-b", "release"]);
  upstreamCommit(upstream, "rel.txt", "x\n", "release adds rel.txt");
  git(upstream, ["checkout", "-q", "main"]);
  const r = runScript(work, ["--no-install", "--branch=release"]);
  ok(fs.existsSync(path.join(work, "rel.txt")), "--branch=release 生效");
}

console.log(failed ? `\n✗ ${failed} 项失败，${pass} 项通过` : `\n✓ 全部 ${pass} 项通过`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
