#!/usr/bin/env node
// 证人 ③：出货链最省事的那根杠杆。js/engine/generate.js 的文件头写着——
//   「求解器推完的那个 state 就是答案本身——不需要另外存：既然计数器已经证明全盘只有一个解，
//     而 checkSolution 验过这个 state 是解，那它必然**就是**那个解。这句话是这仓最省事的正确性
//     杠杆，所以它被写成 tests/shipping.test.mjs 里的一条断言。」
// 这里就是那条断言，而且故意**不读 generate 自己记的 solution 字段**：
//   左值 = 独立跑一遍 solve(reg) 推出的 state；
//   右值 = 独立跑一遍 countByRegion(reg) 数出来的那唯一一条；
// 两者必须由**外部证据**对上，generate 记的那条只当第三个读数一起摆上来。
//
// 另钉三件：
//   · 决定论的底子：rng 的 mulberry32 与 FNV-1a 在这里按**公开算法定义**重写一遍参考实现，
//     与引擎逐位对账。引擎换了浮点、换了字符串哈希、或者在 sort 比较器里抽随机数（本组织栽过：
//     node 与 Chrome 因此画两张不同的盘），这一节立刻红。
//   · 形状的天花板 n ≤ maxSize·k 与 2k ≤ n（区域要装得下两黑格），从数组算，不信自记读数。
//   · 唯一性的**证明形状**：拿 not=那条解 的替代解探针重跑一遍，必须 exhausted && count===0。
import { generate, attempt, TIERS, KNOWN_REASONS } from '../js/engine/generate.js';
import { countByRegion } from '../js/engine/counter.js';
import { solve, stateToBlack } from '../js/engine/solver.js';
import { checkSolution, regionsOf } from '../js/engine/grid.js';
import { makeRng, hashString, derive } from '../js/engine/rng.js';

let checks = 0;
const fails = [];
const notes = [];
const ok = (cond, name, detail = '') => {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
};
const key = (b) => Array.from(b).join('');

/* ── 参考实现：按公开定义重写，不看引擎源码 ──────────────────────────── */
function refMulberry32(seed) {
  let a = seed >>> 0;
  if (a === 0) a = 1; // 引擎避开 0 这个不动点（rng.js 里那条注释），参考实现必须同样处理才有得比
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function refFnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

{
  const seeds = [1, 20260929, 20260934, 0xffffffff, 7];
  let worstDiff = 0;
  for (const s of seeds) {
    const a = makeRng(s);
    const b = refMulberry32(s);
    let same = true;
    for (let i = 0; i < 2000; i += 1) {
      const x = a();
      const y = b();
      if (x !== y) same = false;
    }
    ok(same, `rng：种子 ${s} 的 2000 步必须与参考实现逐位相同`);
    const r = makeRng(s);
    const v = [r(), r(), r()];
    ok(v.every((x) => x >= 0 && x < 1), `rng：输出必须落在 [0,1)`, v.join(','));
  }
  for (const tag of ['', 'shape:warmup', 'dig:hard', '6x6#3-a1b2c3', '标准', 'x'.repeat(200)]) {
    ok(hashString(tag) === refFnv1a(tag), `hashString：「${tag.slice(0, 16)}」必须等于 FNV-1a 参考值`,
      `${hashString(tag)} vs ${refFnv1a(tag)}`);
    ok(Number.isInteger(hashString(tag)) && hashString(tag) >= 0, 'hashString：必须是 uint32 整数');
  }
  // 派生：同 (seed,tag) 同值；不同 tag 必须给不同的数（否则两段挪刀共用同一条随机流，tag 就是假的）
  const tags = TIERS.map((t) => `dig:${t.key}`).concat(TIERS.map((t) => `polish:${t.key}`), TIERS.map((t) => `shape:${t.key}`));
  const derived = new Set();
  for (const tg of tags) {
    const d = derive(20260936, tg);
    ok(Number.isInteger(d) && d >= 0 && d <= 0xffffffff, `derive：「${tg}」必须是 uint32 整数`);
    ok(derive(20260936, tg) === d, `derive：「${tg}」必须可重入`);
    derived.add(d);
  }
  ok(derived.size === tags.length, `${tags.length} 个 tag 的派生种子必须两两不同`, `${derived.size}`);
  notes.push(`rng：${seeds.length} 个种子 × 2000 步与 mulberry32 参考实现逐位相同；`
    + `${tags.length} 个 tag 的派生种子互不相同`);
}

/* ── 杠杆：求解器的终局 state == 穷举器数出的唯一解（都不经 generate 的手）── */
{
  let boards = 0;
  let equal = 0;
  for (const tier of TIERS) {
    const want = tier.key === 'hard' ? 1 : 2; // 硬骨档一张 ~2s（balance 实测 p95 581ms、最慢 2.3s），只抽 1 张
    let got = 0;
    for (let i = 0; got < want && i < 200; i += 1) {
      const g = generate(tier.key, derive(20260937, `lev:${tier.key}:${i}`));
      if (!g.ok) continue;
      got += 1;
      boards += 1;
      const tag = `${tier.key}#${i}`;
      const run = solve(g.reg, tier.w, tier.h);
      const counted = countByRegion(g.reg, tier.w, tier.h);
      ok(run.complete && !run.contradiction, `${tag}：求解器必须推到底`, `unknown=${run.unknown}`);
      ok(counted.exhausted && counted.count === 1, `${tag}：穷举器必须数到恰好 1`, `${counted.count}/${counted.exhausted}`);
      const fromSolver = key(stateToBlack(run.state));
      const fromCounter = key(counted.solutions[0]);
      ok(fromSolver === fromCounter, `${tag}：求解器的终局必须**就是**穷举器那条唯一解（这条杠杆不读 generate 记的字段）`,
        `${fromSolver} vs ${fromCounter}`);
      ok(fromSolver === key(g.solution) && fromSolver === key(g.constructed),
        `${tag}：generate 记的 solution 与构造时的 B 都必须是同一条`);
      ok(checkSolution(stateToBlack(run.state), g.reg, tier.w, tier.h).ok, `${tag}：这条落子必须过完整判定`);
      // 形状天花板：区域要装得下两黑格（2k ≤ n），区域不许大过 maxSize（n ≤ maxSize·k）
      const k = regionsOf(g.reg, tier.w, tier.h).length;
      ok(2 * k <= tier.w * tier.h && tier.w * tier.h <= tier.maxSize * k,
        `${tag}：必须满足 2k ≤ n ≤ maxSize·k`, `k=${k} n=${tier.w * tier.h}`);
      // 唯一性的证明形状：拿 not=那条解 的替代解探针重跑，必须"数完且一条都没有"
      const alt = countByRegion(g.reg, tier.w, tier.h, { want: 1, not: g.solution });
      ok(alt.exhausted && alt.count === 0, `${tag}：排除真解后的替代解探针必须数完 0 条`, `${alt.count}/${alt.abort}`);
      equal += 1;
    }
    ok(got === want, `${tier.key}：抽不到 ${want} 张出货盘`, `${got}`);
  }
  notes.push(`杠杆：${boards} 张出货盘（每档 ${TIERS.map((t) => (t.key === 'hard' ? 1 : 2)).join('/')}），`
    + `solve 的终局与 countByRegion 的唯一解逐位相同 ${equal}/${boards}`);
}

/* ── 出货闸的形状：不合格盘是被"丢掉"的，不是被放宽的 ───────────────── */
{
  // 同一条种子链重放两次：每次尝试的 reason 序列必须逐张一样（"换一局"是同一条链的前提）。
  const tier = TIERS[1];
  const seed = derive(20260938, 'chain');
  const chainOf = (sd) => {
    const out = [];
    for (let i = 0; i < 24; i += 1) {
      const a = attempt(tier, derive(sd, `${tier.key}#${i}`));
      out.push(a.ok ? `ok:${key(a.solution)}` : `no:${a.reason}`);
      if (a.ok) break;
    }
    return out;
  };
  // 挑一条"先被拒过、后来才出货"的链：一条就中的链没验到 reason 的可重放性。
  let seed2 = seed;
  let c1 = chainOf(seed2);
  for (let s = 0; c1.length < 2 && s < 40; s += 1) {
    seed2 = derive(seed, `chain:${s}`);
    c1 = chainOf(seed2);
  }
  ok(c1.length >= 2, '需要一条至少被拒过一次才出货的尝试链（否则 reason 重放没被验到）', `${c1.length}`);
  const c2 = chainOf(seed2);
  ok(JSON.stringify(c1) === JSON.stringify(c2), '尝试链必须可重放（逐张同 reason/同盘）',
    `${c1.length} vs ${c2.length}`);
  ok(c1[c1.length - 1].startsWith('ok:'), '这条链必须在 24 次之内出货', c1[c1.length - 1]);
  for (const step of c1.slice(0, -1)) {
    const r = step.slice(3);
    ok(KNOWN_REASONS.includes(r), `链上出现没登记的丢弃原因「${r}」`);
  }
  notes.push(`尝试链：${c1.length} 次尝试出货，丢弃原因 ${JSON.stringify(c1.slice(0, -1).map((s) => s.slice(3)))}`);
  // 阶梯的粗轴：格数必须严格递增（chain p50 有三档并列在 9，尺寸是剩下那把尺子）
  for (let i = 1; i < TIERS.length; i += 1) {
    const a = TIERS[i - 1];
    const b = TIERS[i];
    ok(a.w * a.h < b.w * b.h, `阶梯：${b.key} 的格数必须严格大于 ${a.key}`, `${b.w * b.h} vs ${a.w * a.h}`);
    ok(b.maxSize <= 5, `阶梯：maxSize=${b.maxSize} 越过实测上限（6x6 ≤6 实测 0/12 出货，它是可行性旋钮不是难度旋钮）`);
  }
}

console.log(`出货链证人 · ${notes.length} 条观测`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT shipping-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
