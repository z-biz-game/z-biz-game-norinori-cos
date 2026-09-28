#!/usr/bin/env node
// npm test / CI 的总门：三道静态门（语法、引擎禁词、分层）→ 逐个跑逻辑套件读它们的 RESULT 行
// → 再用**标定样本量**跑一遍难度实测（tools/balance.mjs）。
//
// 为什么静态门跑在逻辑门前面：引擎里混进一个 Math.random 或 process.env，逻辑测试**当天**还是全绿的
// （node 恰好有那个环境变量、或者随机数恰好站在正确答案那边），红的是三个月后的部署站点或另一台机器。
// 本组织真栽过：sort 比较器里抽随机数，node 与 Chrome 因此画两张不同的盘 ⇒ 同一种子两种结果。
// 所以这两条不许靠"跑一遍看看"，必须在读源码的门里就打死。
//
// 为什么要**数 RESULT 的行数**：套件被改名、被漏跑、spawn 失败但退出码没传上来，
// 这三种情况都会表现为"绿了，但少跑了一套"——而"少跑一套"正是这一族门禁最常见的腐化方式。
// 所以：清单里的套件必须在磁盘上存在、必须真的跑起来、必须打 RESULT 行、RESULT 自报名必须等于
// 由文件名算出的那一个、ok 必须 true、fails 必须 0、checks 必须 > 0，且收到的行数必须等于清单长度。
//
// 本阶段只有纯 Node 部分：没有 index.html、没有 server.cjs、没有 tools/verify.sh
// （浏览器壳还没开工，它们的入口不许写进来，写了就是空头承诺）。
// 仓根的 _tmp-* 临时探针一律跳过 —— 它们不归门禁管，但也不许混进 commit。
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['js', 'tools', 'tests'];
const EXTS = ['.js', '.mjs', '.cjs'];
const EXTRA_JS = []; // 第二阶段发浏览器壳时才点名 server.cjs
const SHELLS = []; // 第二阶段才有 tools/verify.sh
const SKIP = (name) => name.startsWith('_tmp-');
// 引擎 6 + tools 8（四套逻辑门 + 夹具 + 观测器 + balance + 本文件）+ tests 3 张证人 = 17
// 少了就是目录被清空/改名；这条不是拿来"卡新增文件"的，新增只会让它一直富余。
const MIN_SOURCE_FILES = 17;
const ENGINE_DIR = 'js/engine';
const ENGINE_MODULES = ['counter.js', 'generate.js', 'grid.js', 'partition.js', 'rng.js', 'solver.js'];
// tests/ 三张证人各自钉一句引擎文件头里的承诺，删一张就是那句话没人证了
const MIN_TEST_FILES = 3;

// 清单：tools 里点名的四套逻辑门 + 夹具自检，外加两处自动发现：
//   tools/*-test.mjs —— 下一轮加进来的套件一落地就自动进闸，不许出现"进了 package.json 却没进门禁"；
//   tests/*.test.mjs —— 同上，一张新证人不必改这里。
// 删一张则因为 MIN_* 与「收到的 RESULT 行数 ≠ 清单长度」当场红 —— 漏跑比跑红更危险。
const REQUIRED_SUITES = [
  'tools/rule-test.mjs', 'tools/counter-test.mjs', 'tools/solver-test.mjs',
  'tools/generate-test.mjs', 'tools/scenarios.js',
];
const MIN_TOOL_SUITES = 4; // tools/*-test.mjs 至少四套（rule/counter/solver/generate）

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile() && EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

// RESULT 的自报名由文件名算出：tools/rule-test.mjs → rule-test、tests/r1-equiv.test.mjs → r1-equiv-test。
// 改了文件名不改 RESULT 标签（或反过来）就是"两套证人变成一套 / 一套被当成没跑"，必须红。
// 两张证人与四套 tools 门的名字因此**故意不同名**（rules 与 rule 那种一字之差也算不同名）：
// 标签撞车会让"少跑一套"在 CI 日志里读不出来。
function suiteName(rel) {
  const base = rel.split('/').pop().replace(/\.(mjs|js|cjs)$/, '');
  return rel.startsWith('tests/') ? `${base.replace(/\.test$/, '')}-test` : base;
}

let checks = 0;
let fails = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) {
    fails++;
    console.error(`  ✗ ${msg}`);
  }
  return !!cond;
};

/* ---------- 1) 语法门 ---------- */
const files = DIRS.map((d) => join(ROOT, d))
  .filter((d) => existsSync(d))
  .reduce((acc, d) => walk(d, acc), []);
for (const rel of EXTRA_JS) if (existsSync(join(ROOT, rel))) files.push(join(ROOT, rel));
ok(files.length >= MIN_SOURCE_FILES, `只找到 ${files.length} 个源文件（至少 ${MIN_SOURCE_FILES}），目录名不对？`);
let jsBad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    jsBad++;
    ok(false, `node --check ${relative(ROOT, f)}\n${(r.stderr || '').trim()}`);
  }
}
let shellBad = 0;
const presentShells = SHELLS.filter((rel) => existsSync(join(ROOT, rel)));
for (const rel of presentShells) {
  const r = spawnSync('bash', ['-n', join(ROOT, rel)], { encoding: 'utf8' });
  if (r.status !== 0) {
    shellBad++;
    ok(false, `bash -n ${rel}\n${(r.stderr || '').trim()}`);
  }
}
const shellNote = presentShells.length
  ? `；bash -n：${presentShells.length - shellBad}/${presentShells.length} 个 shell 脚本${shellBad ? `，失败 ${shellBad} 个` : '，零失败'}`
  : '；bash -n：本阶段还没有 shell 脚本';
console.log(`语法门：node --check ${files.length - jsBad}/${files.length} 个文件通过（${DIRS.join('、')} 下所有 ${EXTS.join('/')}，跳过 _tmp-*）${shellNote}`);

/* ---------- 2) 引擎侧禁词：判定路径上不许有随机数、时间、环境 ----------
 * Math.random      : seed 必须是纯函数；一次随机 = node 与 Chrome 画出两张不同盘（家族里已经栽过）
 * Date.now / new Date / performance.now : 判定路径上不许有时间，也不许把墙钟当输入
 *   （墙钟属于 tools/balance.mjs 那一层，它是**读数**，永远不是出题的输入）
 * process.env      : 测量口径属于调用方，引擎读 env 就等于把出货口径交给部署环境
 * require / node:  : 引擎是纯 ESM 零运行时依赖；读了 Node 内置模块就带不进浏览器，也就进不了 Pages 产物
 */
const FORBID = [
  ['Math.random', /Math\.random/],
  ['Date.now / new Date', /Date\.now|\bnew Date\b/],
  ['performance.now', /performance\.now/],
  ['process.env', /process\.env/],
  ['require(', /\brequire\s*\(/],
  ['node: 内置模块（from）', /from\s+['"]node:/],
  ['node: 内置模块（动态 import）', /import\s*\(\s*['"]node:/],
];
const engineDir = join(ROOT, ENGINE_DIR);
ok(existsSync(engineDir), `没有 ${ENGINE_DIR} 目录：禁词门无源可查`);
const engineFiles = existsSync(engineDir) ? walk(engineDir, []) : [];
ok(engineFiles.length === ENGINE_MODULES.length, `${ENGINE_DIR} 应该有 ${ENGINE_MODULES.length} 个文件（${ENGINE_MODULES.join('/')}），实为 ${engineFiles.length} 个`);
for (const want of ENGINE_MODULES) ok(existsSync(join(engineDir, want)), `${ENGINE_DIR}/${want} 不在了（引擎六模块少一个，门禁的清单就得同步改）`);
let tokenHits = 0;
for (const f of engineFiles) {
  const src = readFileSync(f, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // 注释里谈禁词是文档，不是违规
  for (const [name, re] of FORBID) {
    if (re.test(code)) {
      tokenHits++;
      ok(false, `${relative(ROOT, f)}：判定路径上出现「${name}」`);
    }
  }
}
console.log(`禁词门：${engineFiles.length} 个引擎文件 × ${FORBID.length} 个禁词，注释外命中 ${tokenHits} 处`);

/* ---------- 3) 分层门：引擎不许反向依赖 tools/ ---------- */
// 出题、判定、求解都住在 js/；tools/ 是**读数与闸**。一旦引擎 import tools/，
// 夹具里的期望值就进了判定路径 —— 那等于把"程序是对的"改成"夹具是这么写的"。
let layerHits = 0;
for (const f of engineFiles) {
  const src = readFileSync(f, 'utf8');
  if (/from\s+['"][^'"]*(tools|\.\.\/)\//.test(src)) {
    layerHits++;
    ok(false, `${relative(ROOT, f)}：引擎反向 import 了 tools/（夹具不许站进判定路径）`);
  }
}
console.log(`分层门：${engineFiles.length} 个引擎文件里反向依赖 ${layerHits} 处`);

/* ---------- 4) 逻辑套件：逐条断言各自的 RESULT 行 ---------- */
const relOf = (p) => relative(ROOT, p).split('\\').join('/');
const discoveredTests = existsSync(join(ROOT, 'tests')) ? walk(join(ROOT, 'tests'), []).filter((p) => p.endsWith('.test.mjs')).map(relOf) : [];
const discoveredTools = existsSync(join(ROOT, 'tools')) ? walk(join(ROOT, 'tools'), []).filter((p) => p.endsWith('-test.mjs')).map(relOf) : [];
ok(discoveredTests.length >= MIN_TEST_FILES, `tests/ 下只发现 ${discoveredTests.length} 张 *.test.mjs（至少 ${MIN_TEST_FILES}）：证人被删了还是目录改名了？`);
ok(discoveredTools.length >= MIN_TOOL_SUITES, `tools/ 下只发现 ${discoveredTools.length} 套 *-test.mjs（至少 ${MIN_TOOL_SUITES}）：同上，套数少了就是闸松了。`);
for (const rel of REQUIRED_SUITES) ok(existsSync(join(ROOT, rel)), `清单里的套件 ${rel} 不在磁盘上（改名/删除就是漏跑，不许静默掉）`);

const suites = [...new Set([...REQUIRED_SUITES, ...discoveredTools, ...discoveredTests])];
const names = suites.map(suiteName);
ok(new Set(names).size === names.length, `套件标签必须两两不同（撞标签会让"少跑一套"读不出来）：${names.join(' ')}`);
const got = [];
for (const rel of suites) {
  const name = suiteName(rel);
  if (!existsSync(join(ROOT, rel))) continue; // 上面已经算红一次，这里不再 spawn
  const r = spawnSync(process.execPath, [rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split('\n').reverse().find((l) => l.startsWith('RESULT ')) || '';
  const m = /^RESULT\s+(\S+)\s+ok=(\S+)\s+checks=(\d+)\s+fails=(\d+)/.exec(line);
  if (!ok(!!m, `${name}: 没打印 RESULT 行（退出码 ${r.status}）\n${out.slice(-800)}`)) continue;
  got.push(name);
  ok(m[1] === name, `${name}: RESULT 自称 ${m[1]}，与由文件名算出的套件名不符`);
  ok(m[2] === 'true' && Number(m[4]) === 0 && r.status === 0, `${name}: ok=${m[2]} fails=${m[4]} 退出码=${r.status}\n${out.split('\n').filter((l) => l.startsWith('  ✗')).slice(0, 8).join('\n')}`);
  ok(Number(m[3]) > 0, `${name}: checks=0，等于没断言`);
  // 把每套自己的 RESULT 行**原样**再念一遍：CI 那一侧数的就是这些行。
  // 只报一条聚合行的话，"少跑了一套"在门禁那一侧读不出来——它看到的永远是 1 行绿。
  console.log(line);
}
ok(got.length === suites.length, `只收到 ${got.length}/${suites.length} 套 RESULT（清单 ${suites.length} 条）：漏了 ${suites.filter((s) => !got.includes(suiteName(s))).join(' ') || '无'} —— 少跑一套就是这一族门禁最常见的腐化`);

/* ---------- 5) 难度实测：按**标定样本量**跑 balance，并断言它的尾判据真的评了 ---------- */
// balance 那一边有自己的十条判据与 --dose 自证；这一层不重算，只钉三件事：它跑了、它绿了、
// 它是在标定样本量上跑的（withheld=0）。第三条才是重点：每档 25 次 attempt 时 tricky/hard 各只出货
// 1 张盘，med/p95 那几条尾判据按 balance 头部 ⑥ 的口径**不评**，balance 于是照打一行绿但自报
// withheld=19（本机 2026-09-29 实测）。那一行不是结论，所以这里必须红 ——
// "把 --samples 调小"从此不是一条省时间的路。
const BALANCE_SAMPLES = 150; // 必须等于 tools/balance.mjs 里的 CALIBRATION_SAMPLES（线表 provenance 那一次）
const BALANCE_MIN_CHECKS = 277; // 标定样本上的实测条数（25 次只有 129）：判据只许增加，不许失踪
{
  const rel = 'tools/balance.mjs';
  ok(existsSync(join(ROOT, rel)), `观测器 ${rel} 不在磁盘上：难度这条线没人跑（改名的话清单要同步改）`);
  const r = spawnSync(process.execPath, [rel, `--samples=${BALANCE_SAMPLES}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.split('\n').reverse().find((l) => l.startsWith('RESULT balance')) || '';
  const m = /^RESULT\s+balance\s+ok=(\S+)\s+checks=(\d+)\s+fails=(\d+)\s+samples=(\d+)\s+withheld=(\d+)/.exec(line);
  if (ok(!!m, `balance: 没打印带 samples/withheld 的 RESULT 行（退出码 ${r.status}）\n${out.slice(-800)}`)) {
    ok(m[1] === 'true' && Number(m[3]) === 0 && r.status === 0,
      `balance: ok=${m[1]} fails=${m[3]} 退出码=${r.status}\n${out.split('\n').filter((l) => l.startsWith('  ✗')).slice(0, 8).join('\n')}`);
    ok(Number(m[2]) >= BALANCE_MIN_CHECKS,
      `balance: checks=${m[2]} < 标定样本上量到的 ${BALANCE_MIN_CHECKS} ⇒ 有判据被删或样本不对`);
    ok(Number(m[4]) === BALANCE_SAMPLES,
      `balance: 自报 samples=${m[4]}，与门禁要求的标定样本量 ${BALANCE_SAMPLES} 不符 ⇒ 尾统计量不成立（⑥）`);
    ok(Number(m[5]) === 0,
      `balance: 自报还有 ${m[5]} 条尾判据**没评** ⇒ 这一轮不是结论，不许当绿用`);
  }
  console.log(line);
}

console.log(`\n合计：源文件 ${files.length}、引擎 ${engineFiles.length}、套件 ${suites.length}（点名 ${REQUIRED_SUITES.length} + tools 自动发现 ${discoveredTools.length} + tests 自动发现 ${discoveredTests.length}）、跑成 ${got.length}、难度实测 samples=${BALANCE_SAMPLES}`);
console.log(`RESULT check ok=${fails === 0} checks=${checks} fails=${fails}`);
process.exit(fails === 0 ? 0 : 1);
