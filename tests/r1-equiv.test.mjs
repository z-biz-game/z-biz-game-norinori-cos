#!/usr/bin/env node
// 证人 ①：规则本体。js/engine/grid.js 的文件头把话说死在一条等价上——
//   "黑格两两成骨牌、骨牌之间不共边" ⟺ "每个黑格的 4-邻域里恰有一个黑格"
// 并且写明"这条等价在 tests/r1-equiv.test.mjs 里用**另一套**显式骨牌枚举器逐盘对账，不靠上面这段推理自证"。
// 这个文件就是那笔账：左值走 r1Violations（度数判定），右值走一个独立的骨牌枚举器
// （递归配对 + 逐对查共边），两者对**全盘所有** 2^(w·h) 个落子逐盘比，一个都不跳过。
//
// 另外钉三条从**来源**读出来的事实（来源逐字引在 DESIGN.md §一）：
//   · 共角不算顶死（对角不在 4-邻域里）——给一张 witness 盘。
//   · 白格必须连通**不是**规则：给一张人手验过的盘，它的白格碎成四块而 checkSolution 说 ok。
//     加一条没来源的规则会让穷举器否掉真合法的解，所以这条必须有人证着。
//   · 骨牌可以跨区域边界：regionDominoCounts 在出货盘上两种都数得出（"整颗在区域内"和"跨界的"）。
import {
  cellIndex, rowOf, colOf, neighbors, buildAdjacency, regionsOf,
  validatePartition, r1Violations, r2Violations, checkSolution, formatBoard,
} from '../js/engine/grid.js';
import { regionDominoCounts } from '../js/engine/partition.js';
import { generate, TIERS } from '../js/engine/generate.js';
import { derive } from '../js/engine/rng.js';

let checks = 0;
const fails = [];
const notes = [];
const ok = (cond, name, detail = '') => {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
};

/* ── 独立枚举器：把黑格配成骨牌，再逐对查共边。不读 r1Violations，也不用度数。 ── */
// 返回 true ⟺ 存在一种配法：每颗黑格恰属一颗 1x2/2x1 骨牌，且任意两颗不共边。
function dominoTilable(black, w, h) {
  const cells = [];
  for (let i = 0; i < black.length; i += 1) if (black[i]) cells.push(i);
  if (cells.length % 2 === 1) return false; // 奇数颗黑格配不成对
  const adj = buildAdjacency(w, h);
  const used = new Uint8Array(black.length);
  const placed = [];
  const sharesEdge = (a, b) => {
    for (const x of a) for (const nb of adj[x]) if (b.includes(nb)) return true;
    return false;
  };
  const rec = (from) => {
    while (from < cells.length && used[cells[from]]) from += 1;
    if (from === cells.length) return true;
    const a = cells[from];
    used[a] = 1;
    for (const nb of adj[a]) {
      if (!black[nb] || used[nb]) continue;
      const d = [a, nb];
      if (placed.some((p) => sharesEdge(p, d))) continue;
      used[nb] = 1;
      placed.push(d);
      if (rec(from + 1)) {
        used[a] = 0; used[nb] = 0; placed.pop();
        return true;
      }
      used[a] = 0; used[nb] = 0; placed.pop();
    }
    used[a] = 0;
    return false;
  };
  return rec(0);
}

/* ── 1) 几何：邻域的顺序与形状 ───────────────────────────────────────── */
{
  const w = 4;
  const h = 4;
  for (let r = 0; r < h; r += 1) {
    for (let c = 0; c < w; c += 1) {
      const i = cellIndex(w, r, c);
      ok(i === r * w + c && rowOf(i, w) === r && colOf(i, w) === c, `几何：(${r},${c}) 的索引往返`);
    }
  }
  // 上右下左固定顺序 ⇒ 任何用它的产物都是决定论的（跨引擎画同一张盘的前提）
  ok(JSON.stringify(neighbors(5, 4, 4)) === JSON.stringify([1, 6, 9, 4]), '几何：内部格 5 的邻域必须是 上右下左 [1,6,9,4]', JSON.stringify(neighbors(5, 4, 4)));
  ok(JSON.stringify(neighbors(0, 4, 4)) === JSON.stringify([1, 4]), '几何：左上角 0 的邻域必须是 [1,4]');
  ok(JSON.stringify(neighbors(15, 4, 4)) === JSON.stringify([11, 14]), '几何：右下角 15 的邻域必须是 [11,14]');
  const adj = buildAdjacency(4, 4);
  const deg = adj.map((a) => a.length);
  ok(deg.filter((d) => d === 2).length === 4, '几何：4x4 的角格度数必须是 4 个 2');
  ok(deg.filter((d) => d === 3).length === 8, '几何：4x4 的边格度数必须是 8 个 3');
  ok(deg.filter((d) => d === 4).length === 4, '几何：4x4 的内部格度数必须是 4 个 4');
  let symmetric = true;
  for (let i = 0; i < 16; i += 1) for (const nb of adj[i]) if (!adj[nb].includes(i)) symmetric = false;
  ok(symmetric, '几何：邻接表必须对称');
}

/* ── 2) 剖分判定：什么算一张合法的区域图 ────────────────────────────── */
{
  // 手写并逐块点过：a={4,8,12} b={9,11,13,14,15} c={5,6,10} d={0,1,2,3,7}
  const reg = [3, 3, 3, 3, 0, 2, 2, 3, 0, 1, 2, 1, 0, 1, 1, 1];
  const v = validatePartition(reg, 4, 4);
  ok(v.ok, '剖分：手写的这块图必须合法', v.why || '');
  ok(v.regionCount === 4 && JSON.stringify(v.sizes) === JSON.stringify([3, 5, 3, 5]),
    '剖分：区域数与大小读数', `${v.regionCount}/${v.sizes.join(',')}`);
  // 四条拒绝路径逐条点名（计数器与求解器都靠这些前提才不白跑）
  ok(!validatePartition(reg.slice(0, 15), 4, 4).ok, '剖分：长度不等于 w·h 必须拒');
  const gap = [...reg];
  gap[0] = 9;
  ok(!validatePartition(gap, 4, 4).ok, '剖分：区域号有空洞必须拒');
  // 逐块点过：a={0} 单格；b={1,2,3} c={4,5} d={6,7,10} e={8,12} f={9,13} g={11,14,15} 全连通
  const one = 'abbb/ccdd/efdg/efgg'.split('').filter((c) => c !== '/').map((ch) => 'abcdefgh'.indexOf(ch));
  const oneV = validatePartition(one, 4, 4);
  ok(!oneV.ok && oneV.why.includes('只有 1 格'),
    '剖分：单格区域必须拒，且要说清是 R2 装不下', oneV.why);
  // 逐块点过：0 号 = {0,1,12}，12 的邻格是 4 号与 5 号 ⇒ 0 号碎成两块孤岛；其余五块都连通、都 ≥2 格
  const island = [0, 0, 1, 1, 2, 2, 1, 3, 4, 4, 3, 3, 0, 5, 5, 5];
  const isV = validatePartition(island, 4, 4);
  ok(!isV.ok && isV.why.includes('孤岛'), '剖分：同色但不连通必须拒', isV.why);
}

/* ── 3) 主账：R1 的度数判定 ⟺ 独立骨牌枚举器，逐盘比完 ──────────────── */
for (const [w, h] of [[2, 2], [3, 3], [4, 4]]) {
  const n = w * h;
  const adj = buildAdjacency(w, h);
  let agree = 0;
  let passR1 = 0;
  let passTiling = 0;
  const mismatch = [];
  const black = new Uint8Array(n);
  for (let m = 0; m < (1 << n); m += 1) {
    for (let i = 0; i < n; i += 1) black[i] = (m >> i) & 1;
    const degOk = r1Violations(black, adj).length === 0;
    const tilOk = dominoTilable(black, w, h);
    if (degOk) passR1 += 1;
    if (tilOk) passTiling += 1;
    if (degOk === tilOk) agree += 1;
    else if (mismatch.length < 3) mismatch.push(`${w}x${h} 落子 ${formatBoard(black, w, h).replace(/\n/g, '/')}：度数=${degOk} 骨牌=${tilOk}`);
  }
  ok(mismatch.length === 0, `等价：${w}x${h} 全盘 ${1 << n} 个落子必须两套判定逐盘同真值`, mismatch.join(' | '));
  ok(agree === (1 << n), `等价：${w}x${h} 对账必须覆盖全盘`, `${agree}/${1 << n}`);
  notes.push(`${w}x${h}：${1 << n} 个落子全比，度数判 ${passR1} 个成立，骨牌枚举 ${passTiling} 个配得成（${passR1 === passTiling ? '两笔账相等' : '不等'}）`);
}

/* ── 4) 顶死的形状：2x2 不行、共角行 ────────────────────────────────── */
{
  const adj = buildAdjacency(4, 4);
  const block = new Uint8Array(16);
  for (const i of [0, 1, 4, 5]) block[i] = 1; // 2x2 实心块
  ok(r1Violations(block, adj).length === 4 && !dominoTilable(block, 4, 4),
    'R1：2x2 实心块每颗黑格有两个黑邻居，且配不出不共边的骨牌');
  const cornerTouch = new Uint8Array(16);
  for (const i of [0, 1, 6, 7]) cornerTouch[i] = 1; // 骨牌 (0,1) 与 (6,7)：1 与 6 是对角，只碰角不共边
  ok(r1Violations(cornerTouch, adj).length === 0 && dominoTilable(cornerTouch, 4, 4),
    'R1：两颗骨牌共角不算顶死（来源只说不得共边）');
  const line = new Uint8Array(16);
  for (const i of [0, 1, 2]) line[i] = 1; // 三连
  ok(r1Violations(line, adj).length > 0 && !dominoTilable(line, 4, 4),
    'R1：三连黑格既过不了度数也配不成对');
}

/* ── 5) 白格连通不是规则：一张人手验过的盘 ──────────────────────────── */
{
  // reg 行优先：region a={4,8,12} b={9,11,13,14,15} c={5,6,10} d={0,1,2,3,7}
  // 每块恰两黑（R2）；黑格是四颗横骨牌 (2,3)(4,5)(10,11)(12,13)，两两隔着一行/一列白格（R1）。
  // 白格 {0,1}、{6,7}、{8,9}、{14,15} 四块互不相连——若把"白格必须连通"当成规则，这张盘会被否掉，
  // 而 Nikoli 与 cross+A 两个源都没有这一条。
  const reg = [3, 3, 3, 3, 0, 2, 2, 3, 0, 1, 2, 1, 0, 1, 1, 1];
  const black = [0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0];
  const v = validatePartition(reg, 4, 4);
  ok(v.ok && v.regionCount === 4, '白格证人：这张剖分必须合法', v.why || '');
  ok(JSON.stringify(v.sizes) === JSON.stringify([3, 5, 3, 5]), '白格证人：区域大小必须是 3/5/3/5', v.sizes.join(','));
  ok(checkSolution(Uint8Array.from(black), reg, 4, 4).ok, '白格证人：两条规则都满足 ⇒ checkSolution 必须说 ok');
  const adj = buildAdjacency(4, 4);
  const white = [];
  for (let i = 0; i < 16; i += 1) if (!black[i]) white.push(i);
  const seen = new Set([white[0]]);
  const q = [white[0]];
  while (q.length) {
    const cur = q.pop();
    for (const nb of adj[cur]) if (!black[nb] && !seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  ok(white.length === 8 && seen.size === 2,
    '白格证人：白格必须确实是碎的（8 格、从 0 号白格只走到 2 格）', `${seen.size}/${white.length}`);
  notes.push('白格连通不是规则：证人盘 4 块孤白而 checkSolution=ok（加这条会否掉真合法的解）');
}

/* ── 6) R2 与完整判定：违规要点名到具体区域 ─────────────────────────── */
{
  const reg = [0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 3, 3, 2, 2, 3, 3];
  const regions = regionsOf(reg, 4, 4);
  const good = new Uint8Array(16);
  for (const i of [0, 1, 6, 7, 8, 9, 14, 15]) good[i] = 1;
  ok(r2Violations(good, regions).length === 0, 'R2：每块两黑 ⇒ 零违规');
  const starved = Uint8Array.from(good);
  starved[1] = 0;
  ok(JSON.stringify(r2Violations(starved, regions)) === JSON.stringify([0]),
    'R2：少一颗黑格必须点名到 0 号区域', JSON.stringify(r2Violations(starved, regions)));
  const over = Uint8Array.from(good);
  over[2] = 1;
  ok(r2Violations(over, regions).includes(1), 'R2：多一颗黑格必须点名到 1 号区域');
  // checkSolution 的先后：R1 先报（它管落子形状，R2 管区域配额；顺序固定 ⇒ 测试读得到同一句）
  const both = Uint8Array.from(good);
  both[1] = 0;
  both[3] = 1;
  const c = checkSolution(both, reg, 4, 4);
  ok(c.ok === false && c.rule === 'R1', 'checkSolution：两条都坏时必须先报 R1', JSON.stringify(c));
}

/* ── 7) 骨牌可以跨区域边界：出货盘上两种形状都要数得出 ──────────────── */
{
  let whole = 0;
  let crossed = 0;
  let boards = 0;
  for (const tier of TIERS.slice(0, 3)) {
    for (let i = 0; i < 4 && boards < 12; i += 1) {
      const g = generate(tier.key, derive(20260933, `rd:${tier.key}:${i}`));
      if (!g.ok) continue;
      boards += 1;
      const adj = buildAdjacency(g.w, g.h);
      const partner = new Int16Array(g.w * g.h).fill(-1);
      for (let c = 0; c < g.solution.length; c += 1) {
        if (!g.solution[c]) continue;
        const nb = adj[c].find((x) => g.solution[x]);
        partner[c] = nb;
      }
      const rc = regionDominoCounts(g.reg, g.solution, partner, g.w, g.h);
      ok(rc.total === rc.whole.length + rc.crossed.length && rc.total === g.metrics.regionCount,
        `${tier.key}#${i}：整颗+跨界必须等于区域数`, `${rc.whole.length}+${rc.crossed.length} vs ${g.metrics.regionCount}`);
      // 独立复核：跨界的那些区域，其两黑格的骨牌伙伴确实落在别的区域里
      for (const r of regionsOf(g.reg, g.w, g.h)) {
        const bl = r.filter((c) => g.solution[c]);
        ok(bl.length === 2, `${tier.key}#${i}：每块区域恰两黑`, `${bl.length}`);
        if (partner[bl[0]] === bl[1]) whole += 1;
        else {
          crossed += 1;
          ok(g.reg[bl[0]] !== g.reg[partner[bl[0]]], `${tier.key}#${i}：判成跨界的骨牌，伙伴必须在别的区域`, '');
        }
      }
    }
  }
  ok(boards >= 6, '证人 7 需要至少 6 张出货盘', `${boards}`);
  ok(whole > 0 && crossed > 0, '造题器不许退回到"骨牌全在区域内"的子族：整颗与跨界都必须出现', `${whole}/${crossed}`);
  notes.push(`骨牌形状：${boards} 张出货盘里 整颗 ${whole} 块 / 跨界 ${crossed} 块（两种都出得来）`);
}

console.log(`规则证人 · ${notes.length} 条观测`);
for (const n of notes) console.log(`  · ${n}`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT r1-equiv-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
