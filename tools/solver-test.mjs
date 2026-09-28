#!/usr/bin/env node
// 零猜测求解器的性质门。它同时是提示通道和难度量纲的实现，所以这里查的不只是"推得完"：
//   ① 完备性 × 唯一性：出货盘必须推到底，而且推出来的那份落子**就是**穷举器数出来的唯一解
//      （两条独立证人：按区域枚举 + 授权范围内的小盘暴力枚举）。
//   ② 可靠性：在**多解**盘上（手解盘，解集是人列的），推出的每一条事实都必须被全部解支持。
//      这条才是"提示只给可证事实"的根据——玩家的中间局面本来就是多解的。
//   ③ 不自证：喂一个与唯一解矛盾的落子，求解器要么报矛盾、要么停住，
//      **绝不许"推完"出一盘不合法的解**（推完了就是它以为自己证明了什么）。
//   ④ 读数口径：steps = 全盘格数、rounds ≥ 1、byRule 之和 = steps、log 每条都带轮号。
//   ⑤ 决定论：同一张盘重放两次，事实序列逐条相同（提示是给玩家看的，不许一次一个样）。
import { solve, deriveFacts, deriveOne, stateToBlack, RULES, BLACK, WHITE, UNKNOWN } from '../js/engine/solver.js';
import { checkSolution, validatePartition, regionsOf } from '../js/engine/grid.js';
import { countByRegion, countByBitmask } from '../js/engine/counter.js';
import { generate, TIERS } from '../js/engine/generate.js';
import { derive } from '../js/engine/rng.js';
import { HAND, parseReg } from './fixtures.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
const key = (b) => Array.from(b).join('');
const PER_TIER = Number(process.env.SOLVER_SAMPLES ?? 8);
const BASE = 20260931;

/* ── ①④⑤ 出货盘：推到底、推出来的是唯一解、读数口径对 ─────────────── */
let boards = 0;
const ruleUse = {};
for (const tier of TIERS) {
  let got = 0;
  for (let i = 0; i < 60 && got < PER_TIER; i += 1) {
    const g = generate(tier.key, derive(BASE, `sv:${tier.key}:${i}`));
    if (!g.ok) continue;
    got += 1;
    boards += 1;
    const { w, h } = tier;
    const n = w * h;
    ok(validatePartition(g.reg, w, h).ok, `${tier.key}#${i}：出货盘剖分必须合法`);
    const run = solve(g.reg, w, h);
    ok(run.complete && !run.contradiction, `${tier.key}#${i}：出货盘必须不靠猜推到底`,
      `complete=${run.complete} unknown=${run.unknown} contra=${JSON.stringify(run.contradiction)}`);
    const ans = stateToBlack(run.state);
    ok(key(ans) === key(g.solution), `${tier.key}#${i}：求解器推出来的落子必须等于出货记录里的解`);
    ok(key(ans) === key(g.constructed), `${tier.key}#${i}：造题时那条落子(B)必须一路活到出货——挖与磨都不许把答案换掉`);
    ok(checkSolution(ans, g.reg, w, h).ok, `${tier.key}#${i}：推出来的落子必须过完整判定`);
    const c1 = countByRegion(g.reg, w, h, { budget: 400_000 });
    ok(c1.exhausted && c1.count === 1, `${tier.key}#{i}：按区域穷举必须数到恰好 1 个解`,
      `count=${c1.count} exhausted=${c1.exhausted} atLeast=${c1.atLeast}`);
    if (n <= 20) {
      const c2 = countByBitmask(g.reg, w, h);
      ok(c2.ok && c2.count === 1, `${tier.key}#${i}：第二套穷举器（整盘暴力）也必须数到 1`, JSON.stringify(c2));
    } else {
      const c2 = countByBitmask(g.reg, w, h);
      ok(!c2.ok, `${tier.key}#${i}：超过 20 格时暴力枚举器必须拒绝，而不是给个数`, JSON.stringify(c2));
    }
    // 读数口径
    ok(run.steps === n, `${tier.key}#${i}：推完时 steps 必须等于全盘格数`, `steps=${run.steps} n=${n}`);
    ok(run.rounds >= 1 && run.unknown === 0, `${tier.key}#${i}：rounds ≥1 且 unknown=0`, `rounds=${run.rounds}`);
    ok(Object.keys(run.byRule).every((k) => k in RULES), `${tier.key}#${i}：byRule 里不许出现规则表外的名字`,
      Object.keys(run.byRule).join(','));
    ok(Object.values(run.byRule).reduce((a, b) => a + b, 0) === run.steps,
      `${tier.key}#${i}：byRule 之和必须等于 steps`, `${JSON.stringify(run.byRule)} vs ${run.steps}`);
    ok(run.log.every((f) => Number.isInteger(f.round) && f.round >= 1), `${tier.key}#${i}：log 每条都要带轮号`);
    for (const [k, v] of Object.entries(run.byRule)) ruleUse[k] = (ruleUse[k] || 0) + v;
    // ⑤ 决定论：重放一遍，逐条相同
    const again = solve(g.reg, w, h);
    ok(JSON.stringify(again.log) === JSON.stringify(run.log), `${tier.key}#${i}：同一张盘重放必须逐条相同`);
    ok(again.rounds === run.rounds && again.steps === run.steps, `${tier.key}#${i}：读数必须稳定`);
    // 提示通道：中途任意时刻给的那一条都必须与唯一解一致，而且必须是本轮可证事实
    const state = new Uint8Array(n);
    for (let s = 0; s < run.log.length; s += 3) {
      const one = deriveOne(g.reg, w, h, state);
      if (!ok(!one.conflict, `${tier.key}#${i}：正确落子的途中不该报矛盾`, JSON.stringify(one.conflict))) break;
      if (one.fact) {
        const want = g.solution[one.fact.cell] === 1 ? 'B' : 'W';
        ok((one.fact.value === BLACK ? 'B' : 'W') === want,
          `${tier.key}#${i}：提示第 ${s} 步给的「${one.fact.cell}=${one.fact.value === BLACK ? '黑' : '白'}」必须与唯一解一致`,
          `唯一解里那格是 ${want}`);
      }
      const f = run.log[s];
      if (f && state[f.cell] === UNKNOWN) state[f.cell] = f.value;
    }
  }
  ok(got >= 1, `${tier.key}：60 个种子里一张出货盘都没有`);
}
notes.push(`出货盘 ${boards} 张全部推到底｜byRule 总账 ${Object.entries(ruleUse).map(([k, v]) => `${k}:${v}`).join(' ')}`);
if (ruleUse.LONER === undefined) {
  notes.push('LONER 在出货路径上一次都没发声（观测，不是红线）：它服务的场景是**玩家中途的局面**——见 ②；'
    + '出货盘的密度让"四邻皆白"的格几乎不出现。');
}

/* ── ② 多解盘上的可靠性：每条事实都要被全部解支持 ──────────────────── */
for (const fx of HAND) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const sols = fx.sols.map((cells) => {
    const b = new Uint8Array(fx.w * fx.h);
    for (const c of cells) b[c] = 1;
    return b;
  });
  const c = countByRegion(reg, fx.w, fx.h, { want: 64 });
  ok(c.exhausted && c.count === sols.length, `手解盘 ${fx.reg}：穷举器必须数到人列的那 ${sols.length} 条`,
    `实为 ${c.count}`);
  const run = solve(reg, fx.w, fx.h);
  ok(!run.contradiction, `手解盘 ${fx.reg}：活局不该报矛盾`, JSON.stringify(run.contradiction));
  for (const f of run.log) {
    const want = f.value === BLACK ? 1 : 0;
    const bad = sols.filter((s) => s[f.cell] !== want);
    ok(bad.length === 0, `手解盘 ${fx.reg}：第 ${f.cell} 格判${want ? '黑' : '白'}（${f.rule}）必须被全部 ${sols.length} 条解支持`,
      `${bad.length} 条解反对`);
  }
  if (!run.complete) {
    ok(run.unknown > 0, `手解盘 ${fx.reg}：没推完就得留下未定格`, `${run.unknown}`);
    notes.push(`手解盘 ${fx.reg}：五条规则推到 ${run.steps}/${fx.w * fx.h} 格停住（${sols.length} 条解的盘本来就推不完，这是明说的边界）`);
  }
  // 唯一解那张手解盘：求解器必须自己推到底，且推出的就是人列的那一条
  if (sols.length === 1) {
    ok(run.complete, `手解盘 ${fx.reg}（唯一解）必须推到底`, `unknown=${run.unknown}`);
    ok(key(stateToBlack(run.state)) === key(sols[0]), `手解盘 ${fx.reg}：推出来的必须等于人列的那条解`,
      `${key(stateToBlack(run.state))} vs ${key(sols[0])}`);
  }
}

/* ── ③ 喂错的落子：不许"推完"出一盘不合法的解 ─────────────────────── */
{
  let flips = 0;
  const ended = { contradiction: 0, stalled: 0, completeInvalid: 0 };
  const bad = [];
  for (const tier of [TIERS[0], TIERS[1]]) {
    let got = 0;
    for (let i = 0; i < 40 && got < 3; i += 1) {
      const g = generate(tier.key, derive(BASE, `fl:${tier.key}:${i}`));
      if (!g.ok) continue;
      got += 1;
      const { w, h } = tier;
      for (let cell = 0; cell < w * h; cell += 1) {
        if (g.solution[cell]) continue; // 只翻"真白却判黑"的那种错
        const state = new Uint8Array(w * h);
        state[cell] = BLACK;
        const run = solve(g.reg, w, h, { state });
        flips += 1;
        if (run.contradiction) ended.contradiction += 1;
        else if (!run.complete) ended.stalled += 1;
        else if (checkSolution(stateToBlack(run.state), g.reg, w, h).ok) {
          // 唯一的红：错着还被"推完"成合法盘。那说明这盘其实有第二条解，出货时的唯一性证明是假的。
          bad.push(`${tier.key} 第 ${cell} 格判黑后推完整盘且合法：${key(stateToBlack(run.state))}`);
        } else ended.completeInvalid += 1;
      }
    }
  }
  ok(bad.length === 0, `喂错不许被"推完"成合法盘（${bad.length} 例）`, bad.slice(0, 4).join(' / '));
  notes.push(`喂错落子 ${flips} 次：报矛盾 ${ended.contradiction}｜停在未定 ${ended.stalled}｜推完但不合法 ${ended.completeInvalid}｜推完且合法 ${bad.length}（最后一项必须是 0）`);
}

/* ── 规则表的最后一道：deriveFacts 在已定格的格上不许改主意 ─────────── */
{
  const tier = TIERS[2];
  const g = (() => {
    for (let i = 0; i < 60; i += 1) {
      const r = generate(tier.key, derive(BASE, `freeze:${i}`));
      if (r.ok) return r;
    }
    return null;
  })();
  ok(!!g, '定格门需要一张标准档出货盘');
  if (g) {
    const run = solve(g.reg, tier.w, tier.h);
    for (let cut = 1; cut < run.log.length; cut += Math.max(1, Math.floor(run.log.length / 6))) {
      const state = new Uint8Array(tier.w * tier.h);
      for (let j = 0; j < cut; j += 1) state[run.log[j].cell] = run.log[j].value;
      const { facts, conflict } = deriveFacts(g.reg, tier.w, tier.h, state);
      ok(!conflict, `前缀 ${cut} 不该报矛盾`, JSON.stringify(conflict));
      ok(facts.every((f) => state[f.cell] === UNKNOWN), `前缀 ${cut}：已定格的格不许被重新判`,
        facts.filter((f) => state[f.cell] !== UNKNOWN).map((f) => f.cell).join(','));
    }
  }
}

console.log(`零猜测求解器 · ${notes.length} 条观测`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT solver-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
