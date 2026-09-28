// 造题面：Norinori 的题面就是区域剖分，所以"随便切一刀再去看有没有解"是死路——
// 实测随机剖分 98.3% 根本无解（两块相邻的 2 格区域会互相顶死：每块都被 R2 逼成两黑，
// 于是跨边界那两个黑格各有两个黑邻居，违反 R1）。60 抽 × 5 档，2026-09-29 本机。
//
// 所以这里反过来做，三步：
//  1) **摆骨牌**：随机顺序扫格子，能放下一张 1x2/2x1 且不与任何已放骨牌共边就放下。
//     放下后这两格的所有其它邻居永久不能变黑（否则违反 R1）。这给出一个合法落子 B。
//  2) **长区域**：每块区域从一颗未分配的骨牌端点出发做随机行走，走到撞上另一颗黑格为止
//     （撞上自己那半颗也允许——真题面里两种都有）。行走时只吞未分配的格 ⇒ 区域天然连通；
//     每吞一格都要求"剩下的未分配格仍连通"，否则会把某颗黑格永远孤在角落里。
//     最后把没人收的白格分给相邻且没长满的区域。
//  3) **挖唯一解**：只挪"对 B 是白、对另一条解是黑"的格，让它离开那条解所在的区域。
//     挪走一个 B 的白格不动任何区域的 B 黑格数 ⇒ B 永远是解（挖到 1 就是恰 1，不会挖空）。
//     区域满了就整对交换（c→Y、d→X，两格对两条解都是白的）。每步拿 counter.js 的另一条解当靶子。
//
// 第 2 步刻意不要求"每块区域恰含一颗骨牌"：实测那种子族解数中位数 941（6x6，本机
// 2026-09-29），离唯一差得太远，挖不动；让两黑格可以来自两颗不同骨牌才挖得下去。
// 卡住就整盘重启，重启与挪格次数都记进返回值，让生成器自己有多别扭可被量。

import { buildAdjacency, regionsOf, validatePartition, checkSolution } from './grid.js';
import { randInt, shuffle } from './rng.js';
import { findSolutions } from './counter.js';
import { solve } from './solver.js';

const FREE = 0;
const BLACK = 1;
const BLOCKED = 2; // 不能变黑：要么已是某颗骨牌的邻居，要么自己就是白格

// ── 第 1 步：摆骨牌 ─────────────────────────────────────────────────
/**
 * @returns {{black:Uint8Array, partner:Int32Array, dominoes:number}}
 *   partner[i] = i 的那半颗骨牌（黑格才有意义）。
 */
export function packDominoes(w, h, next) {
  const adj = buildAdjacency(w, h);
  const n = w * h;
  const kind = new Uint8Array(n);
  const partner = new Int32Array(n).fill(-1);
  const dominoes = [];
  const order = shuffle(next, Array.from({ length: n }, (_, i) => i));
  for (const c of order) {
    if (kind[c] !== FREE) continue;
    const cand = shuffle(next, adj[c].filter((nb) => kind[nb] === FREE));
    if (!cand.length) {
      kind[c] = BLOCKED;
      continue;
    }
    const p = cand[randInt(next, cand.length)];
    kind[c] = BLACK;
    kind[p] = BLACK;
    partner[c] = p;
    partner[p] = c;
    dominoes.push([c, p]);
    for (const nb of adj[c]) if (kind[nb] === FREE) kind[nb] = BLOCKED;
    for (const nb of adj[p]) if (kind[nb] === FREE) kind[nb] = BLOCKED;
  }
  // 对外只交 0/1：BLOCKED 也是非零值，谁把它当"是不是黑格"用就会数错。
  const black = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) black[i] = kind[i] === BLACK ? 1 : 0;
  return { black, partner, dominoes: dominoes.length };
}

// 剩下的未分配格是不是仍连成一片（空集算连通）。
// 这条守卫保证：只要还有两颗黑格没配对，它们之间就还存在一条全未分配的路，
// 下一次行走总有办法把它们连起来。
function unassignedConnected(unassigned, adj) {
  let total = 0;
  let start = -1;
  for (let i = 0; i < unassigned.length; i += 1) {
    if (unassigned[i]) { total += 1; if (start < 0) start = i; }
  }
  if (total <= 1) return true;
  const seen = new Uint8Array(unassigned.length);
  const stack = [start];
  seen[start] = 1;
  let got = 1;
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of adj[cur]) {
      if (unassigned[nb] && !seen[nb]) { seen[nb] = 1; got += 1; stack.push(nb); }
    }
  }
  return got === total;
}

/**
 * @returns {{ok:true, reg:Int16Array, black:Uint8Array, partner:Int32Array,
 *            dominoes:number, sizes:number[], restarts:number}
 *          | {ok:false, why:string, restarts:number}}
 */
export function makeShape(w, h, next, opts = {}) {
  const maxSize = opts.maxSize ?? 8;
  // 2 格区域的产出概率（百分数）。这不是审美：2 格区域是求解器唯一不靠别人就能点亮的起点
  // （R2 当场把它两格都判黑），而实测"0 块 2 格区域"的盘五条规则**一步都推不动**
  // ——200 盘/档、平均 0.0 步、卡住整盘格数，本机 2026-09-29。没有种子，出货率的上限就是 0。
  const pairProb = opts.pairProb ?? 25;
  const adj = buildAdjacency(w, h);
  const n = w * h;

  for (let restart = 0; restart < 80; restart += 1) {
    const packed = packDominoes(w, h, next);
    if (!packed.dominoes) continue;
    const black = packed.black;

    const reg = new Int16Array(n).fill(-1);
    const unassigned = new Uint8Array(n).fill(1);
    const size = [];
    let left = 0;
    for (let i = 0; i < n; i += 1) if (black[i]) left += 1;

    let failed = false;
    while (left > 0 && !failed) {
      // 起点：任意一颗还没配对的骨牌端点
      const starts = [];
      for (let i = 0; i < n; i += 1) if (black[i] && unassigned[i]) starts.push(i);
      const seed = starts[randInt(next, starts.length)];
      const rid = size.length;
      size.push(0);
      const grow = (cell) => {
        reg[cell] = rid;
        unassigned[cell] = 0;
        size[rid] += 1;
        if (black[cell]) left -= 1;
      };
      grow(seed);
      const inRegion = [seed];
      while (size[rid] < maxSize) {
        const frontier = [];
        for (const cell of inRegion) {
          for (const nb of adj[cell]) if (unassigned[nb]) frontier.push(nb);
        }
        if (!frontier.length) { failed = true; break; }
        const blacks = frontier.filter((c) => black[c]);
        // 收黑格＝封这块区域。白格也能走，但走一步要先确认没把谁孤在身后。
        const takeBlack = blacks.length
          && (size[rid] >= 2 || left === 1 || randInt(next, 100) < pairProb);
        if (takeBlack) {
          grow(blacks[randInt(next, blacks.length)]);
          break;
        }
        const whites = shuffle(next, frontier.filter((c) => !black[c]));
        const ok = whites.find((c) => {
          unassigned[c] = 0;
          const keep = unassignedConnected(unassigned, adj);
          unassigned[c] = 1;
          return keep;
        });
        if (ok === undefined) {
          // 白格一个都不能吞（吞了就把剩下的黑格隔开了）：那就只能收黑格。
          if (!blacks.length) { failed = true; break; }
          grow(blacks[randInt(next, blacks.length)]);
          break;
        }
        grow(ok);
        inRegion.push(ok);
      }
    }
    if (failed || left > 0) continue;

    // 收尾：没人配的白格分给相邻且没长满的区域，**先填最大的那块**。
    // 按体积降序不是随手一改：升序会把刚留出来的 2 格种子区立刻灌满，
    // 而 2 格区正是上面 pairProb 花概率买来的东西（实测两者差一个数量级的推进量）。
    let progress = true;
    let stranded = 0;
    for (let i = 0; i < n; i += 1) if (unassigned[i]) stranded += 1;
    while (stranded > 0 && progress) {
      progress = false;
      for (const cell of shuffle(next, Array.from({ length: n }, (_, k) => k).filter((k) => unassigned[k]))) {
        if (!unassigned[cell]) continue;
        const seen = new Set();
        const opts2 = [];
        for (const nb of adj[cell]) {
          const id = reg[nb];
          if (id >= 0 && size[id] < maxSize && !seen.has(id)) { seen.add(id); opts2.push(id); }
        }
        if (!opts2.length) continue;
        let best = -1;
        for (const id of shuffle(next, opts2)) if (best < 0 || size[id] > size[best]) best = id;
        reg[cell] = best;
        unassigned[cell] = 0;
        size[best] += 1;
        stranded -= 1;
        progress = true;
      }
    }
    if (stranded > 0) continue;

    const v = validatePartition(reg, w, h);
    if (!v.ok) continue;
    const chk = checkSolution(black, reg, w, h);
    if (!chk.ok) continue; // 构造自检：B 必须是解，不是就重启（不让它带着谎往下走）
    return { ok: true, reg, black, partner: packed.partner, dominoes: packed.dominoes, sizes: v.sizes, restarts: restart };
  }
  return { ok: false, why: '80 次都没长出自洽剖分', restarts: 80 };
}

// ── 第 3 步：挖唯一解 ───────────────────────────────────────────────
// 靶子不是"探到的那 8 条替代解"，而是**穷举器数出来的替代解条数**。
// 换得起：在 ≤6x6 上数穿一棵树只要几毫秒（本机 2026-09-29，预算 3M 结点：6x4 0.5ms、6x6 17ms），
// 而且探针要找的是"除了 B 之外的前 want 条"，一旦凑够就早退，所以每**试**一刀只花零点几毫秒。
// 换来两件事：
//   1) 接受判据回到它本来该有的样子——替代解**变少**；proxy 时代那套
//      "已顶死名单 + 不许复活"的机器整块删掉（它是数不准时的补丁，数得准就不需要）。
//   2) 收敛性照旧，而且更好说：被接受的刀要么让替代解条数严格变小，
//      要么在条数不变时走进一条 seen 集合里没有的剖分。状态有限 ⇒ 要么数到 0，
//      要么走满 maxMoves 后整盘丢掉，不会打转。
// 数到 0 那一次**本身就是穷举证明**：want=cur+1 的探针只有在整棵树走完的情况下才可能
// 返回"没凑够 cur+1 条"，所以 exhausted && count===0 ⇔ "除了 B 没有第二条"，
// 出货前不需要再补一遍全量计数（nodes 就是这次证明的结点数，直接进难度量纲的读数）。
// 刀法两条，共同点是**都不改任何区域的 B 黑格数** ⇒ B 永远是解，所以挖到 0 是"恰 1 条"，不会挖空：
//   单格搬迁：把一格 B 的白格挪进邻区（邻区要装得下，原区域拆开后还要连通）；
//   同色交换：两格对 B 同色互换归属——一增一减正好抵消，区域尺寸原地不动，所以不吃 maxSize。
export function digToUnique(reg, black, w, h, next, opts = {}) {
  const maxSize = opts.maxSize ?? 8;
  // 起手只接"替代解不超过 cap 条"的盘。这不是省事，是挑盘：实测同一档里初始替代解
  // 从 2 条到 1440 条都有（6x4 4 盘样本，本机 2026-09-29），而挖一刀平均只去掉三成——
  // 从 1440 条起步的盘挖不完，把它算到底只是浪费预算。超了直接判 not-promising，换下一张形状。
  const cap = opts.cap ?? 16;
  const budget = opts.budget ?? 400_000;
  const maxMoves = opts.maxMoves ?? 300;
  const adj = buildAdjacency(w, h);
  const size = regionsOf(reg, w, h).map((c) => c.length);
  const rej = { full: 0, detached: 0, cut: 0, tried: 0, kept: 0 };
  let moves = 0;

  const alts = (want) => findSolutions(reg, w, h, { want, not: black, budget });
  const key = () => Array.from(reg).join(',');
  const better = (p, cur) => p.exhausted
    && validatePartition(reg, w, h).ok && checkSolution(black, reg, w, h).ok
    && (p.count < cur || (p.count === cur && !seen.has(key())));

  const first = alts(cap);
  if (!first.exhausted) return { ok: false, why: 'not-promising', moves: 0, altsAtLeast: cap, rej };
  let cur = first.count;
  const seen = new Set([key()]);
  let proofNodes = first.nodes;

  while (cur > 0) {
    if (moves >= maxMoves) return { ok: false, why: 'move-budget', moves, alts: cur, rej };
    let stepped = false;
    for (const mv of shuffle(next, legalMoves(reg, size, adj, black, maxSize, rej))) {
      rej.tried += 1;
      applyMove(reg, size, mv);
      const p = alts(cur + 1);
      if (better(p, cur)) {
        cur = p.count;
        proofNodes = p.nodes;
        seen.add(key());
        moves += 1;
        rej.kept += 1;
        stepped = true;
        break;
      }
      undoMove(reg, size, mv);
    }
    if (!stepped) return { ok: false, why: 'no-legal-move', moves, alts: cur, rej };
  }
  return { ok: true, moves, count: 1, nodes: proofNodes, killed: seen.size - 1, rej };
}

// 这一刀落得下去吗：单格搬迁要求"搬得走（原区域拆了还连通、且不少于 2 格）+ 邻区装得下"；
// 同色交换只要求"两块换完之后各自仍连通"。理由都写在被调用的那两个函数头上。
// 拒绝原因照常计数进 rej——"挖不动"必须说得出卡在哪一格，否则探针只能报一个形容词。
function legalMoves(reg, size, adj, black, maxSize, rej) {
  const out = [];
  for (let cell = 0; cell < reg.length; cell += 1) {
    const from = reg[cell];
    const dests = neighbourRegions(reg, adj, cell, from);
    if (!black[cell]) {
      if (staysConnected(reg, adj, from, cell)) {
        for (const to of dests) {
          if (size[to] + 1 > maxSize) { rej.full += 1; continue; }
          out.push({ cell, from, to, d: -1 });
        }
      } else rej.cut += 1;
    }
    for (const to of dests) {
      for (const d of regionCells(reg, to)) {
        if (black[d] !== black[cell] || d === cell) continue;
        // 连通性只对"交换之后的两块"判定，不拆成"去掉一格还连通 + 补位格贴得上"这种充分条件：
        // 后者会把 2 格区域整块排除在外（去掉一格只剩 1 格，本来补位格就能接上它），
        // 而 2 格区是 solver 唯一的种子（见 makeShape 的 pairProb），把它禁掉等于自己把路封了。
        if (!regionAfterSwap(reg, adj, from, cell, d) || !regionAfterSwap(reg, adj, to, d, cell)) {
          rej.detached += 1;
          continue;
        }
        out.push({ cell, from, to, d });
      }
    }
  }
  return out;
}

function applyMove(reg, size, mv) {
  if (mv.d < 0) { reg[mv.cell] = mv.to; size[mv.from] -= 1; size[mv.to] += 1; }
  else { reg[mv.cell] = mv.to; reg[mv.d] = mv.from; }
}

function undoMove(reg, size, mv) {
  if (mv.d < 0) { reg[mv.cell] = mv.from; size[mv.from] += 1; size[mv.to] -= 1; }
  else { reg[mv.cell] = mv.from; reg[mv.d] = mv.to; }
}

// ── 第 4 步：在"仍然唯一"的前提下，把盘往"推得动"的方向挪 ────────────
// digToUnique 交出的只是"全盘只有一条解"，而那条解未必能不靠猜推出来——盘一大就基本推不出来
// （本机 2026-09-29，_tmp-polish 每档 20~30 盘，挖通之后 solve 能推完的比例：
//   4x4 5/28、5x4 0/8、6x4 2/7、5x5 0/5、6x5 0/9、6x6 0/2）。
// 所以接着挪刀，接受判据是两条一起：
//   1) 求解器落定的格子数 steps **变大**（或直接推完）；
//   2) **仍然唯一**。want=1 的替代解探针只有在整棵树走完的情况下才可能返回"一条都没凑到"，
//      所以 exhausted && count===0 本身就是穷举证明，不是又一次近似——这一步不另加成本，
//      它是"零猜测"和"唯一解"两句承诺在同一张盘上同时成立的那一刻。
// 先查 1 再查 2：solve() 只要几十微秒，而"仍然唯一"在真的唯一时要数穿整棵树。
//
// plateau：光爬 steps 会在平地上下不来——实测 5x5/6x6 上 96~97% 的候选刀卡在"这一刀不涨格子数"，
// 一刀不中（0/9 推完）。开了 plateau 就再允许"steps 不变但这张剖分没见过"的刀，换来爬出局部最优的脚：
// 6x4 从 2/7 到 **7/7 全推完**、5x5 从 0/5 到 2/5（同一批种子，本机 2026-09-29）。
// 收敛性照旧：要么 steps 严格变大（上界是全盘格数），要么走进 seen 之外的新剖分（状态有限），
// 两条都不会打转；抬到顶或走满 maxMoves 就交盘，推没推完由调用方判——它判的是同一件事，
// 所以这里不自证推完，调用方会再跑一次 solve 并拿它当门槛。
export function polishSolvable(reg, black, w, h, next, opts = {}) {
  const maxSize = opts.maxSize ?? 8;
  const budget = opts.budget ?? 400_000;
  const maxMoves = opts.maxMoves ?? 120;
  const adj = buildAdjacency(w, h);
  const size = regionsOf(reg, w, h).map((c) => c.length);
  const rej = { full: 0, detached: 0, cut: 0, tried: 0, kept: 0, 'not-unique': 0, stalled: 0 };
  const key = () => Array.from(reg).join(',');
  const seen = new Set([key()]);
  let steps = solve(reg, w, h).steps;
  let moves = 0;
  // 出货盘的"唯一"证明结点数：一刀没落过时是 null（调用方沿用 digToUnique 那次），
  // 落了刀就是最后一次落子那刀的证明——metrics 里的 proofNodes 必须描述交出去的那张剖分，
  // 拿中途状态的读数冒充终盘读数，就是给自己记假账。
  let proofNodes = null;

  while (moves < maxMoves) {
    let stepped = false;
    for (const mv of shuffle(next, legalMoves(reg, size, adj, black, maxSize, rej))) {
      rej.tried += 1;
      applyMove(reg, size, mv);
      const run = solve(reg, w, h);
      const betterMove = run.steps > steps
        || (opts.plateau && run.steps === steps && !seen.has(key()));
      if (!run.complete && !betterMove) {
        rej.stalled += 1;
        undoMove(reg, size, mv);
        continue;
      }
      const stillUnique = findSolutions(reg, w, h, { want: 1, not: black, budget });
      if (!stillUnique.exhausted || stillUnique.count !== 0
        || !validatePartition(reg, w, h).ok || !checkSolution(black, reg, w, h).ok) {
        rej['not-unique'] += 1;
        undoMove(reg, size, mv);
        continue;
      }
      steps = run.steps;
      proofNodes = stillUnique.nodes;
      moves += 1;
      seen.add(key());
      rej.kept += 1;
      stepped = true;
      if (run.complete) return { ok: true, complete: true, moves, steps, nodes: proofNodes, rej };
      break;
    }
    if (!stepped) break;
  }
  return { ok: true, complete: false, moves, steps, nodes: proofNodes, rej };
}

// id 号区域去掉 removed、收进 added 之后是否仍是"≥2 格且 4-连通"。
// BFS 从 added 起跳：补位格贴不上主块时，seen 吃不满，自己就会在这里露出来。
function regionAfterSwap(reg, adj, id, removed, added) {
  const keep = new Set([added]);
  for (let i = 0; i < reg.length; i += 1) if (reg[i] === id && i !== removed) keep.add(i);
  if (keep.size < 2) return false;
  const seen = new Set([added]);
  const stack = [added];
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of adj[cur]) if (keep.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return seen.size === keep.size;
}

function regionCells(reg, from) {
  const out = [];
  for (let i = 0; i < reg.length; i += 1) if (reg[i] === from) out.push(i);
  return out;
}

// 去掉 removed 之后，该区域剩下的格还连成一片吗（且至少剩 2 格）。
function staysConnected(reg, adj, from, removed) {
  const keep = new Set(regionCells(reg, from).filter((c) => c !== removed));
  if (keep.size < 2) return false;
  const first = keep.values().next().value;
  const seen = new Set([first]);
  const stack = [first];
  while (stack.length) {
    const cur = stack.pop();
    for (const nb of adj[cur]) if (keep.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return seen.size === keep.size;
}

function neighbourRegions(reg, adj, cell, from) {
  const out = new Set();
  for (const nb of adj[cell]) if (reg[nb] >= 0 && reg[nb] !== from) out.add(reg[nb]);
  return Array.from(out);
}

// 把 reg 压成可读文本（每行一格区域号，a-z 循环）：夹具、截图、日志都用它。
export function formatPartition(reg, w, h) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const lines = [];
  for (let r = 0; r < h; r += 1) {
    let line = '';
    for (let c = 0; c < w; c += 1) line += letters[reg[r * w + c] % 26];
    lines.push(line);
  }
  return lines.join('/');
}

// 参考解里每块区域的两黑格是不是同一颗骨牌（跨界的还是整颗的）——
// 造题器两种都要出得来，测试拿它当"没退回子族"的证人。
export function regionDominoCounts(reg, black, partner, w, h) {
  const whole = [];
  const crossed = [];
  for (const cells of regionsOf(reg, w, h)) {
    const blacks = cells.filter((c) => black[c]);
    const one = blacks.length === 2 && partner[blacks[0]] === blacks[1];
    (one ? whole : crossed).push({ cells: cells.length, black: blacks.length });
  }
  return { whole, crossed, total: whole.length + crossed.length };
}
