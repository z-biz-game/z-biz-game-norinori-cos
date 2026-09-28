#!/usr/bin/env node
// 证人 ②：两套穷举器逐盘同数。js/engine/counter.js 的文件头承诺
//   「小盘上两套必须逐盘给同一个数（tests/counter-agree.test.mjs 钉这条）」
// 这里钉的比那句还严一层：除了两套引擎互相咬，再加**第三套**——本文件里现写的暴力枚举器，
// 它把 2^(w·h) 个落子逐个交给 tests/r1-equiv.test.mjs 同款的独立判定（区域配额 + 骨牌配对不共边），
// 并把**解的集合**（不只是个数）与按区域枚举的那套对账。三套同真值才叫"数得对"。
//
// 顺带钉穷举器出口的四条语义（调用方全靠它们判断能不能信 count）：
//   · exhausted=false ⇒ count 必为 null（"还没数完"和"数出来是 1"是两件事）
//   · budget 撞线 ⇒ abort='budget' 且 atLeast ≤ 全量数
//   · want 提前收工 ⇒ abort='want'
//   · not=某条解 ⇒ exhausted && count===0 读作"它是唯一解"（挖唯一解与收尾证明都走这条）
import { countByRegion, countByBitmask, findSolutions } from '../js/engine/counter.js';
import { buildAdjacency, checkSolution, regionsOf, validatePartition } from '../js/engine/grid.js';
import { generate, TIERS } from '../js/engine/generate.js';
import { derive, makeRng } from '../js/engine/rng.js';
import { HAND } from '../tools/scenarios.js';

let checks = 0;
const fails = [];
const notes = [];
const ok = (cond, name, detail = '') => {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
};
const key = (b) => Array.from(b).join('');

/* ── 第三套：整盘暴力 + 独立判定，返回**解的集合** ────────────────────── */
// 判定不用 r1Violations：骨牌配对走的是 tests/r1-equiv.test.mjs 那套递归配对的同一个思路，
// 但这里要遍历所有配对可能（一张落子可能有一种以上配法），所以写成"存在即可"。
function tilable(black, adj) {
  const cells = [];
  for (let i = 0; i < black.length; i += 1) if (black[i]) cells.push(i);
  if (cells.length % 2) return false;
  const used = new Uint8Array(black.length);
  const placed = [];
  const bad = (d) => placed.some((p) => d.some((c) => adj[c].some((nb) => p.includes(nb))));
  const rec = (from) => {
    while (from < cells.length && used[cells[from]]) from += 1;
    if (from === cells.length) return true;
    const a = cells[from];
    used[a] = 1;
    for (const nb of adj[a]) {
      if (!black[nb] || used[nb]) continue;
      const d = [a, nb];
      if (bad(d)) continue;
      used[nb] = 1;
      placed.push(d);
      if (rec(from + 1)) { used[a] = 0; used[nb] = 0; placed.pop(); return true; }
      used[a] = 0; used[nb] = 0; placed.pop();
    }
    used[a] = 0;
    return false;
  };
  return rec(0);
}
function bruteSolutions(reg, w, h) {
  const n = w * h;
  const adj = buildAdjacency(w, h);
  const regions = regionsOf(reg, w, h);
  const out = [];
  const black = new Uint8Array(n);
  for (let m = 0; m < (1 << n); m += 1) {
    let ones = 0;
    for (let i = 0; i < n; i += 1) { black[i] = (m >> i) & 1; ones += black[i]; }
    if (ones !== regions.length * 2) continue;
    let bad2 = false;
    for (const cells of regions) {
      let c = 0;
      for (const x of cells) c += black[x];
      if (c !== 2) { bad2 = true; break; }
    }
    if (bad2) continue;
    if (tilable(black, adj)) out.push(Uint8Array.from(black));
  }
  return out;
}

/* ── 随机剖分：只用来造对账用的盘，不参与任何判定 ────────────────────── */
function randomPartition(w, h, next, maxSize) {
  const n = w * h;
  const adj = buildAdjacency(w, h);
  const reg = new Int16Array(n).fill(-1);
  let id = 0;
  for (;;) {
    const free = [];
    for (let i = 0; i < n; i += 1) if (reg[i] < 0) free.push(i);
    if (!free.length) break;
    const start = free[Math.floor(next() * free.length)];
    const comp = [start];
    reg[start] = id;
    const want = 2 + Math.floor(next() * (maxSize - 1));
    for (let g = 1; g < want; g += 1) {
      const border = [];
      for (const c of comp) for (const nb of adj[c]) if (reg[nb] < 0 && !border.includes(nb)) border.push(nb);
      if (!border.length) break;
      const pick = border[Math.floor(next() * border.length)];
      reg[pick] = id;
      comp.push(pick);
    }
    id += 1;
  }
  const out = Array.from(reg);
  // 剩下没并入任何块的格子各自成一块：单格块交给 validatePartition 判掉，这张盘就作废重来
  for (let i = 0; i < n; i += 1) if (out[i] < 0) out[i] = id++;
  return out;
}

/* ── 1) 三套穷举器逐盘同数（含解集内容） ─────────────────────────────── */
{
  const boards = [];
  const shapes = [[4, 4], [3, 3], [2, 4], [4, 3], [3, 4]];
  for (const [w, h] of shapes) {
    const next = makeRng(derive(20260934, `part:${w}x${h}`));
    let made = 0;
    for (let t = 0; t < 400 && made < 8; t += 1) {
      const reg = randomPartition(w, h, next, 5);
      const v = validatePartition(reg, w, h);
      if (!v.ok || v.sizes.some((s) => s > 5)) continue;
      boards.push({ w, h, reg });
      made += 1;
    }
  }
  ok(boards.length >= 30, '对账需要至少 30 张随机剖分盘', `${boards.length}`);
  let uniqBoards = 0;
  let emptyBoards = 0;
  let maxCount = 0;
  for (const { w, h, reg } of boards) {
    const tag = `${w}x${h}/${reg.join('')}`;
    const byRegion = countByRegion(reg, w, h, { want: 1_000_000 });
    const byBitmask = countByBitmask(reg, w, h);
    const brute = bruteSolutions(reg, w, h);
    ok(byBitmask.ok, `${tag}：暴力那套必须被授权（n=${w * h} ≤ 20）`, byBitmask.why || '');
    ok(byRegion.exhausted && byRegion.count !== null, `${tag}：小盘必须数到底`, `abort=${byRegion.abort}`);
    ok(byRegion.count === byBitmask.count && byRegion.count === brute.length,
      `${tag}：三套必须给同一个数`, `${byRegion.count}/${byBitmask.count}/${brute.length}`);
    // 解集内容也要相等，不只是条数：两套各自枚举顺序不同，所以比排序后的落子串
    const setA = byRegion.solutions.map(key).sort();
    const setB = brute.map(key).sort();
    ok(JSON.stringify(setA) === JSON.stringify(setB), `${tag}：解集内容必须逐条相同`, `${setA.length} vs ${setB.length}`);
    for (const s of byRegion.solutions) ok(checkSolution(s, reg, w, h).ok, `${tag}：数出来的每条都必须过完整判定`);
    if (byRegion.count === 1) uniqBoards += 1;
    if (byRegion.count === 0) emptyBoards += 1;
    maxCount = Math.max(maxCount, byRegion.count);
  }
  notes.push(`${boards.length} 张随机剖分：三套穷举器逐盘同数（其中 ${uniqBoards} 张唯一解、${emptyBoards} 张无解、最多一张有 ${maxCount} 条解）`);
}

/* ── 2) 手工点解盘：解由人列出来，两套穷举器都得给同一批 ─────────────── */
for (const b of HAND) {
  const reg = b.reg.split('/').join('').split('').map((ch) => ch.charCodeAt(0) - 65);
  const byRegion = countByRegion(reg, b.w, b.h, { want: 1_000_000 });
  const byBitmask = countByBitmask(reg, b.w, b.h);
  const hand = b.sols.map((list) => {
    const s = new Uint8Array(b.w * b.h);
    for (const i of list) s[i] = 1;
    return key(s);
  }).sort();
  const seenR = byRegion.solutions.map(key).sort();
  ok(byRegion.exhausted, `手工盘 ${b.reg}：按区域那套必须数完`, `abort=${byRegion.abort}`);
  ok(byRegion.count === hand.length, `手工盘 ${b.reg}：条数必须等于人列的 ${hand.length}`, `${byRegion.count}`);
  ok(byBitmask.count === hand.length, `手工盘 ${b.reg}：暴力那套也必须等于人列的 ${hand.length}`, `${byBitmask.count}`);
  ok(JSON.stringify(seenR) === JSON.stringify(hand), `手工盘 ${b.reg}：解集必须与人列的逐条相同`, seenR.join(' '));
  for (const s of seenR) ok(hand.includes(s), `手工盘 ${b.reg}：多出一条人没列的解 ${s}`);
}
notes.push(`手工点解盘 ${HAND.length} 张：两套穷举器都给出人列的那一批（张数 ${HAND.map((b) => b.sols.length).join('/')}）`);

/* ── 3) 出口语义：没数完的 count 不是答案 ────────────────────────────── */
{
  const tier = TIERS[3]; // 5x5：全量数得动，小预算一定撞线
  let shipped = null;
  for (let i = 0; i < 60 && !shipped; i += 1) {
    const g = generate(tier.key, derive(20260935, `sem:${i}`));
    if (g.ok) shipped = g;
  }
  ok(!!shipped, '语义门需要一张进阶档出货盘');
  if (shipped) {
    const full = countByRegion(shipped.reg, tier.w, tier.h);
    ok(full.exhausted && full.count === 1, '出货盘必须由按区域那套数到恰好 1', `${full.count}/${full.exhausted}`);
    const broke = countByRegion(shipped.reg, tier.w, tier.h, { budget: 1 });
    ok(!broke.exhausted && broke.count === null && broke.abort === 'budget',
      '预算撞线时 count 必须是 null 且 abort=budget', JSON.stringify({ c: broke.count, a: broke.abort }));
    ok(broke.atLeast <= full.count, `撞线时 atLeast(${broke.atLeast}) 不许超过全量(${full.count})`);
    // want 提前收工：唯一解的盘最多只能给 1 条，且不会谎报 abort
    const one = findSolutions(shipped.reg, tier.w, tier.h, { want: 5 });
    ok(one.solutions.length === 1 && one.atLeast === 1 && one.abort === null,
      'want=5 但全盘只有 1 条解 ⇒ 收工原因必须是 null 而不是 want', JSON.stringify({ l: one.solutions.length, a: one.abort }));
    // not=那条解 ⇒ 数完 0 条，这就是"它是唯一解"的穷举证明形状
    const notB = findSolutions(shipped.reg, tier.w, tier.h, { want: 1, not: shipped.solution });
    ok(notB.exhausted && notB.count === 0, '排除唯一解后必须数完并承认一条都没有', `${notB.count}/${notB.exhausted}`);
    // not=一条非解 ⇒ 那条解还在：拿到一条就按 want 收工（abort='want'、count=null），
    // 而收工那条必须就是出货盘自己的解——排除条不许顺手砍掉真解。
    const flip = Uint8Array.from(shipped.solution);
    flip[flip.indexOf(1)] = 0;
    const notW = findSolutions(shipped.reg, tier.w, tier.h, { want: 1, not: flip });
    ok(!notW.exhausted && notW.count === null && notW.abort === 'want' && notW.atLeast === 1,
      '排除条不是解时应当拿到一条就收工', JSON.stringify({ c: notW.count, a: notW.abort, at: notW.atLeast }));
    ok(notW.solutions.length === 1 && key(notW.solutions[0]) === key(shipped.solution),
      '收工那条必须就是真解本身');
    notes.push(`出口语义：全量 ${full.count} 条 / 撞线 atLeast ${broke.atLeast} 条 / 排除真解后 ${notB.count} 条（数完）/ 排除假解后 ${notW.atLeast} 条（${notW.abort} 收工）`);
  }
  // 越权授权：>20 格的盘暴力那套必须拒，不许给数
  const refused = countByBitmask(shipped.reg, tier.w, tier.h);
  ok(refused.ok === false && /maxCells|授权/.test(refused.why || ''),
    '6x6/5x5 这类大盘必须由暴力那套拒绝授权', JSON.stringify(refused));
}

console.log(`穷举器证人 · ${notes.length} 条观测`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT counter-agree-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
