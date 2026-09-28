#!/usr/bin/env node
// 两套穷举器的对账门。承诺 2 的原话是"唯一解由**第二套**穷举器复核"，这张门就是那句话的可执行形式：
//   ① 同盘同数：2^16 全在授权范围内，逐盘 countByRegion(数完) 与 countByBitmask(暴力) 必须给同一个数。
//   ② 手工点解：两张小盘的解数由人一条条列出来（列在 note 里），两套都必须等于那个手写的数。
//   ③ 排除条语义：not=S 数完是 0 ⇔ "S 之外没有第二条"；not=非解 ⇒ 语义照常成立（不许把非解当解排除）。
//   ④ 没数完的 count 不是答案：exhausted=false 时 count 必须是 null，只许读 atLeast。
//   ⑤ 提前收工：want=k 拿到 k 条就走，atLeast=k、solutions.length=k、exhausted=false。
//   ⑥ 形状不变量：每条解的黑格数 = 2×区域数（R2 的直接后果，两套都得遵守）。
// 期望值全部手写（②那两张盘的枚举是人在纸上走的），红了修引擎，不许把当前输出抄成期望。
import { countByRegion, countByBitmask, findSolutions, DEFAULT_BUDGET } from '../js/engine/counter.js';
import { regionsOf, checkSolution } from '../js/engine/grid.js';
import { makeShape } from '../js/engine/partition.js';
import { makeRng, derive } from '../js/engine/rng.js';
import { TIERS } from '../js/engine/generate.js';
import { parseReg, HAND } from './scenarios.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
const key = (b) => Array.from(b).join('');

/* ── ② 手工点解：两张盘的解由人列出来（表在 scenarios.js，求解器也用同一张）── */
for (const fx of HAND) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const wantSols = fx.sols.map((cells) => {
    const b = new Uint8Array(fx.w * fx.h);
    for (const c of cells) b[c] = 1;
    return b;
  });
  const wantKeys = wantSols.map(key).sort();
  const byRegion = countByRegion(reg, fx.w, fx.h, { want: 64 });
  const byBitmask = countByBitmask(reg, fx.w, fx.h);
  ok(byRegion.exhausted, `手解盘 ${fx.reg}：按区域枚举必须数完`, `atLeast ${byRegion.atLeast}`);
  ok(byBitmask.exhausted, `手解盘 ${fx.reg}：暴力枚举按定义数得完`);
  ok(byRegion.count === wantKeys.length, `手解盘 ${fx.reg}：按区域数到的解数 = 手写的 ${wantKeys.length} 条`, `实为 ${byRegion.count}`);
  ok(byBitmask.count === wantKeys.length, `手解盘 ${fx.reg}：暴力数到的解数 = 手写的 ${wantKeys.length} 条`, `实为 ${byBitmask.count}`);
  const gotKeys = byRegion.solutions.map(key).sort();
  ok(gotKeys.length === wantKeys.length && gotKeys.every((k, i) => k === wantKeys[i]),
    `手解盘 ${fx.reg}：解的**逐格内容**必须等于人列的那几条`, `得到 ${gotKeys.join(' | ')}｜期望 ${wantKeys.join(' | ')}`);
  for (const s of byRegion.solutions) ok(checkSolution(s, reg, fx.w, fx.h).ok, `手解盘 ${fx.reg}：每条解都过 checkSolution`);
  notes.push(`手解盘 ${fx.reg} ⇒ ${wantKeys.length} 条（${fx.note}）`);
}

/* ── ① 两套对账：4x4 全盘暴力跑得动，逐盘比数 ─────────────────────── */
{
  const BASE = 20260929;
  let compared = 0;
  const zero = [];
  const uniq = [];
  const multi = [];
  for (let i = 0; i < 80; i += 1) {
    const s = makeShape(4, 4, makeRng(derive(BASE, `cc:${i}`)), { maxSize: 6 });
    if (!s.ok) continue;
    const a = countByRegion(s.reg, 4, 4, { budget: 500_000 });
    const b = countByBitmask(s.reg, 4, 4);
    if (!ok(a.exhausted, `对账盘 ${i}：按区域枚举必须数完（4x4 跑不完就是预算给错了）`, `atLeast ${a.atLeast} nodes ${a.nodes}`)) continue;
    compared += 1;
    ok(a.count === b.count, `对账盘 ${i}：两套穷举器必须给同一个数`, `按区域 ${a.count}｜暴力 ${b.count}`);
    if (a.count === 0) zero.push(i);
    if (a.count === 1) uniq.push(i);
    if (a.count > 1) multi.push(a.count);
    // solutions 是"至多 want 条拷贝"（默认 want=2），所以它等于条数只在小盘成立；这里要钉的是另一件事：
    // 长度 = min(条数, want) 且**逐条互不相同**——同一个解被数两遍是这类枚举器最阴的洞。
    const ka = a.solutions.map(key);
    ok(ka.length === Math.min(a.count, 2), `对账盘 ${i}：solutions 长度必须等于 min(条数, want=2)`, `${ka.length} vs min(${a.count},2)`);
    ok(new Set(ka).size === ka.length, `对账盘 ${i}：交回的解必须逐条互不相同`, `重复了：${ka.join(' | ')}`);
  }
  ok(compared >= 60, `两套对账至少要比 ${60} 张盘（实为 ${compared}）：makeShape 出货太少说明形状器坏了`);
  notes.push(`两套对账：${compared} 张 4x4 剖分逐盘同数｜0 解 ${zero.length} 张｜唯一解 ${uniq.length} 张｜多解里最大 ${Math.max(...multi, 0)} 条`);
}

/* ── ③ 排除条语义 ─────────────────────────────────────────────────── */
{
  const reg = parseReg(HAND[0].reg, 4, 4);
  const all = countByRegion(reg, 4, 4, { want: 64 });
  const first = all.solutions[0];
  const withoutFirst = findSolutions(reg, 4, 4, { want: 64, not: first });
  ok(withoutFirst.exhausted && withoutFirst.count === all.count - 1,
    `排除条：not=一条真解时，数完的条数必须等于"全盘减一"`, `count=${withoutFirst.count} 全盘 ${all.count}`);
  ok(!withoutFirst.solutions.map(key).includes(key(first)), '排除条：结果里不许再出现被排除的那条');
  // 拿一条**不是解**的落子去排除：不该排除掉任何真解
  const fake = Uint8Array.from(first);
  fake[0] = fake[0] ? 0 : 1;
  ok(!checkSolution(fake, reg, 4, 4).ok, '构造"非解"当排除条：它确实得不是解');
  const withoutFake = findSolutions(reg, 4, 4, { want: 64, not: fake });
  ok(withoutFake.exhausted && withoutFake.count === all.count,
    '排除条：not 指向非解时条数不许变（排除一个不在解集里的东西等于没排除）', `count=${withoutFake.count}`);
}

/* ── ④⑤ 没数完 / 提前收工：半路的 count 不是答案 ─────────────────── */
{
  const tier = TIERS[4]; // 6x6：全盘树大到几千结点，正好用来撞预算
  const g = (() => {
    for (let i = 0; i < 60; i += 1) {
      const s = makeShape(tier.w, tier.h, makeRng(derive(20260930, `bud:${i}`)), { maxSize: tier.maxSize });
      if (s.ok) {
        const c = countByRegion(s.reg, tier.w, tier.h, { budget: DEFAULT_BUDGET });
        if (c.exhausted && c.count > 1) return { reg: s.reg, full: c };
      }
    }
    return null;
  })();
  ok(!!g, '预算门需要先找到一张"解多于一条、又数得完"的 6x6 盘');
  if (g) {
    const starved = countByRegion(g.reg, tier.w, tier.h, { budget: 50 });
    ok(!starved.exhausted && starved.count === null, '撞预算时 count 必须是 null（半路的数当答案就是说谎）',
      `count=${starved.count} exhausted=${starved.exhausted}`);
    // atLeast 是"已经数到的条数"，预算在碰到第一条叶之前就死了它就该是 0——这不是洞，
    // 是 exhausted=false 必须自己站住的原因；真正的红线是它不许超过数完时的条数、且 abort 要说清为什么。
    ok(starved.abort === 'budget' && starved.atLeast >= 0 && starved.atLeast <= g.full.count,
      '撞预算要报 abort=budget，atLeast 只能是"已数到"的下界', JSON.stringify({ a: starved.atLeast, b: starved.abort }));
    ok(starved.nodes <= 51, '撞预算的结点数要停在预算附近（预算没生效就是剪枝写坏了）', `${starved.nodes}`);
    const early = findSolutions(g.reg, tier.w, tier.h, { want: 2 });
    ok(!early.exhausted && early.count === null && early.atLeast === 2 && early.abort === 'want',
      'want=2 拿到两条就收工：atLeast=2、abort=want、count 不是答案',
      JSON.stringify({ c: early.count, a: early.atLeast, b: early.abort }));
    ok(early.solutions.length === 2, 'solutions 数组长度不得超过 want', `${early.solutions.length}`);
    notes.push(`预算门样本：全盘 ${g.full.count} 条解、${g.full.nodes} 结点；budget=50 时 atLeast=${starved.atLeast}`);
  }
}

/* ── ⑥ 形状不变量：黑格数 = 2×区域数，两套都得守 ─────────────────── */
{
  let seen = 0;
  for (let i = 0; i < 30; i += 1) {
    const s = makeShape(4, 4, makeRng(derive(20260931, `inv:${i}`)), { maxSize: 6 });
    if (!s.ok) continue;
    const k = regionsOf(s.reg, 4, 4).length;
    const c = countByRegion(s.reg, 4, 4, { want: 32, budget: 500_000 });
    seen += 1;
    ok(c.solutions.every((sol) => sol.reduce((a, b) => a + b, 0) === 2 * k),
      `不变量盘 ${i}：每条解的黑格数都得是 2×区域数（${2 * k}）`, `有解黑格数不等于 ${2 * k}`);
    ok(c.solutions.every((sol) => checkSolution(sol, s.reg, 4, 4).ok), `不变量盘 ${i}：每条解都过完整判定`);
    ok(s.black.reduce((a, b) => a + b, 0) === 2 * k, `不变量盘 ${i}：形状器自记的落子也守 2×区域数`,
      `${s.black.reduce((a, b) => a + b, 0)} vs ${2 * k}`);
  }
  ok(seen >= 20, `不变量至少查 20 张盘（实为 ${seen}）`);
}

console.log(`穷举器对账 · ${notes.length} 条观测`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT counter-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
