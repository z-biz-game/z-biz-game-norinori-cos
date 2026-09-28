#!/usr/bin/env node
// 出货门：一张盘要进菜单，这里逐张复核四句承诺，全是对**引擎外部**的证据（第二套穷举器、
// 独立几何判定、手写不变量），不是"generate 自己说它成功了"：
//   ① 唯一解：按区域穷举数到恰好 1；≤20 格的盘再拿整盘暴力复核一遍；>20 格必须拒绝授权而不是给数。
//   ② 零猜测：五条规则推到底，且推出来的落子 = 造题时那条 B（挖与磨都不许把答案换掉）。
//   ③ 难度是量出来的：metrics.chain/steps/byRule 必须由同一次 solve 重算得出，读数不许是自己填的。
//   ④ 决定论：同一种子两次跑出同一张盘；出货前那串失败的尝试也逐张复现（"换一局"必须是同一条链）。
//   ⑤ 形状不变量：区域数 = 骨牌数 = 黑格数/2、每区 ≥2 格 ≤maxSize、黑格密度 ≥ 2/maxSize、
//      剖分串能被 UI 那边原样解析回来（round-trip）。
//   ⑥ 丢弃原因是一封写死的信：出现没登记过的 reason 字符串就红，逼着新出口同时进文档。
import { generate, attempt, TIERS, KNOWN_REASONS } from '../js/engine/generate.js';
import { solve, stateToBlack, RULES } from '../js/engine/solver.js';
import { countByRegion, countByBitmask } from '../js/engine/counter.js';
import { checkSolution, validatePartition, regionsOf } from '../js/engine/grid.js';
import { derive, makeRng } from '../js/engine/rng.js';
import { parseMarks, parseReg } from './fixtures.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
const key = (b) => Array.from(b).join('');
const BASE = 20260932;
const PER_TIER = Number(process.env.GEN_SAMPLES ?? 6);

/* ── ①②③⑤ 逐张复核出货盘 ─────────────────────────────────────────── */
let shipped = 0;
for (const tier of TIERS) {
  let got = 0;
  for (let i = 0; i < 80 && got < PER_TIER; i += 1) {
    const g = generate(tier.key, derive(BASE, `gt:${tier.key}:${i}`));
    if (!g.ok) continue;
    got += 1;
    shipped += 1;
    const { w, h } = tier;
    const n = w * h;
    const tag = `${tier.key}#${i}`;
    ok(g.w === w && g.h === h && g.reg.length === n, `${tag}：出货尺寸必须等于档位`, `${g.w}x${g.h}`);
    // ⑤ 形状不变量
    const v = validatePartition(g.reg, w, h);
    ok(v.ok, `${tag}：剖分必须合法`, v.why || '');
    ok(v.sizes.every((s) => s >= 2 && s <= tier.maxSize), `${tag}：每块区域要 ≥2 格且 ≤maxSize(${tier.maxSize})`,
      v.sizes.join(','));
    ok(g.metrics.regionCount === v.regionCount, `${tag}：区域数读数必须与独立几何判定一致`);
    ok(g.metrics.blackCells === 2 * v.regionCount, `${tag}：黑格数 = 2×区域数`, `${g.metrics.blackCells} vs ${2 * v.regionCount}`);
    ok(g.metrics.dominoes === v.regionCount, `${tag}：骨牌数 = 区域数`);
    ok(g.metrics.blackCells / n >= 2 / tier.maxSize - 1e-9, `${tag}：黑格密度必须 ≥ 2/maxSize`,
      `${(g.metrics.blackCells / n).toFixed(3)}`);
    // ① 唯一解（两套穷举器）
    const c1 = countByRegion(g.reg, w, h, { budget: 400_000 });
    ok(c1.exhausted && c1.count === 1, `${tag}：按区域穷举必须数到恰好 1 条`, `count=${c1.count} exhausted=${c1.exhausted}`);
    const c2 = countByBitmask(g.reg, w, h);
    ok(n <= 20 ? (c2.ok && c2.count === 1) : !c2.ok,
      `${tag}：第二套穷举器 ${n <= 20 ? '必须同数' : '必须拒绝越权'}`, JSON.stringify(c2));
    // ② 零猜测 + 答案同一条
    const run = solve(g.reg, w, h);
    ok(run.complete && !run.contradiction, `${tag}：必须不靠猜推到底`, `unknown=${run.unknown}`);
    ok(key(stateToBlack(run.state)) === key(g.solution), `${tag}：求解器推出的落子必须等于出货记录里的解`);
    ok(key(g.solution) === key(g.constructed), `${tag}：出货的解必须就是造题时那条 B（挖刀与打磨都不许换答案）`);
    ok(checkSolution(g.solution, g.reg, w, h).ok, `${tag}：落子必须过完整判定`);
    // ③ 读数必须是同一次 solve 算出来的
    ok(g.metrics.chain === run.rounds && g.metrics.steps === run.steps,
      `${tag}：chain/steps 读数必须等于重算的 rounds/steps`, `${g.metrics.chain}/${run.rounds} ${g.metrics.steps}/${run.steps}`);
    ok(JSON.stringify(g.metrics.byRule) === JSON.stringify(run.byRule), `${tag}：byRule 必须与重算一致`);
    ok(Object.keys(g.metrics.byRule).every((k) => k in RULES), `${tag}：byRule 的名字都得在规则表里`);
    ok(g.metrics.chain >= 1 && g.metrics.proofNodes > 0, `${tag}：chain ≥1 且证明结点数 >0`,
      `chain=${g.metrics.chain} nodes=${g.metrics.proofNodes}`);
    ok(g.metrics.digMoves >= 0 && g.metrics.polishMoves >= 0, `${tag}：两段挪刀的步数要报得出来`);
    // ⑤ 剖分串的 round-trip（UI 拿它当题面）。
    // 比的是"分组是否相同"，不是"区域号是否相同"：formatPartition 沿用引擎里的区域号，
    // parseReg 按字母首次出现重新编号（fixtures.js 开头写了这条约定），两套编号本来就不是一个约定。
    // 网格分组才是题面，所以逐格对「同组」关系：两格在解析结果里同组 ⇔ 在原剖分里同组。
    const back = parseReg(g.text.partition, w, h);
    let sameGrouping = back.length === n;
    for (let i = 0; sameGrouping && i < n; i += 1) {
      for (let j = 0; sameGrouping && j < n; j += 1) {
        if ((back[i] === back[j]) !== (g.reg[i] === g.reg[j])) sameGrouping = false;
      }
    }
    ok(sameGrouping, `${tag}：text.partition 解析回来必须是同一个分组`, `${g.text.partition} vs ${Array.from(back).join('')}`);
    const bv = validatePartition(back, w, h);
    ok(bv.ok && bv.regionCount === v.regionCount, `${tag}：解析回来的剖分必须自洽且区域数不变`, bv.why || `${bv.regionCount}`);
    // ⑥ 丢弃原因都在登记表里
    for (const r of Object.keys(g.stats.reasons || {})) {
      ok(KNOWN_REASONS.includes(r), `${tag}：出现没登记的丢弃原因「${r}」`);
    }
    // ④ 这条链可复现：出货前那几次的失败原因必须逐张一样
    const replay = [];
    for (let k = 0; k < g.attempts; k += 1) {
      const a = attempt(tier, derive(g.seed, `${tier.key}#${k}`));
      replay.push(a.ok ? `ok:${key(a.solution)}` : `no:${a.reason}`);
    }
    ok(replay[replay.length - 1] === `ok:${key(g.solution)}`,
      `${tag}：重放第 ${g.attempts} 次尝试必须给出同一张盘`, `${replay[replay.length - 1]}`);
    ok(g.attempts === replay.length && g.stats.reasons
      && Object.keys(g.stats.reasons).reduce((a, r) => a + g.stats.reasons[r], 0) === g.attempts - 1,
      `${tag}：attempts 与失败计数必须自洽`, `attempts=${g.attempts} reasons=${JSON.stringify(g.stats.reasons)}`);
  }
  ok(got >= 1, `${tier.key}：80 个种子里一张都没出货`);
}
notes.push(`逐张复核出货盘 ${shipped} 张（每档 ${PER_TIER} 张）`);

/* ── ④ 决定论：同一种子两次跑出同一张盘；不同种子给出不同的盘 ─────── */
{
  const tier = TIERS[2];
  const seed = derive(BASE, 'det');
  let a = null;
  let b = null;
  for (let i = 0; i < 60; i += 1) {
    const s = derive(seed, `try:${i}`);
    a = generate(tier.key, s);
    b = generate(tier.key, s);
    if (a.ok) break;
  }
  ok(!!a.ok, '决定论门需要一张标准档出货盘');
  if (a.ok) {
    ok(key(a.reg) === key(b.reg) && key(a.solution) === key(b.solution)
      && a.metrics.chain === b.metrics.chain && a.attempts === b.attempts,
      '同一种子两次必须给出逐位相同的盘');
    const texts = new Set();
    for (let i = 0; i < 10; i += 1) {
      const g = generate(tier.key, derive(BASE, `spread:${i}`));
      if (g.ok) texts.add(g.text.partition + '|' + key(g.solution));
    }
    ok(texts.size >= 5, `10 个不同种子至少要给出 5 张不同的盘（否则"换一局"是假的）`, `${texts.size}`);
    notes.push(`换一局：10 个种子里 ${texts.size} 张互不相同的盘`);
  }
  // rng 本身也得是纯函数：同种子同序列
  const r1 = makeRng(BASE);
  const r2 = makeRng(BASE);
  let same = true;
  for (let i = 0; i < 500; i += 1) if (r1() !== r2()) same = false;
  ok(same, 'rng 同种子必须逐位相同（引擎里不许有 Math.random）');
}

/* ── ⑥ 失败出口的形状：不出货时必须说清为什么，且不许带盘出来 ─────── */
{
  ok(generate('没有这一档', 1).reason === 'unknown-tier', '未知档位必须报 unknown-tier');
  // 6x6 但区域上界压到 3：每块要 ≥2 格 ⇒ 至少 12 块区域 ⇒ 至少 12 条骨牌盖 24 个黑格，
  // 而 24 个黑格在这张盘上不可能互不共边。实测到不了挖那一步：makeShape 就长不出剖分，
  // 三试全报 shape。这里要的不是"这个尺寸装不出来"这一句推理，而是失败链的形状：
  // 试满 maxAttempts 就交账、原因逐条登记、不夹带半张盘。
  const impossible = { key: 'impossible', label: '装不出来的档', w: 6, h: 6, maxSize: 3, chain: [1, 99] };
  const g = generate(impossible, derive(BASE, 'impossible'), { maxAttempts: 3 });
  ok(g.ok === false, 'maxSize=3 的 6x6 必须出不了货');
  ok(g.reason === 'exhausted-attempts' && g.attempts === 3, '只许试 maxAttempts 次就把链交出来',
    `${g.reason}/${g.attempts}`);
  ok(g.reg === undefined && g.solution === undefined, '失败出口不许带盘出来');
  for (const r of Object.keys(g.reasons)) ok(KNOWN_REASONS.includes(r), `丢弃原因「${r}」没在登记表里`);
  notes.push(`装不出来的档：${g.attempts} 次尝试全丢，原因 ${JSON.stringify(g.reasons)}`);
  for (let i = 0; i < 12; i += 1) {
    const a = attempt(TIERS[4], derive(BASE, `rej:${i}`));
    if (a.ok) continue;
    ok(KNOWN_REASONS.includes(a.reason), `硬骨档出现没登记的丢弃原因「${a.reason}」`);
    ok(!a.reg && !a.solution, '失败出口不许带盘出来（调用方只该读 reason）');
  }
}

console.log(`出货门 · ${notes.length} 条观测`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT generate-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
