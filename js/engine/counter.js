// 两套互不复用的穷举器。承诺 2 说的是"唯一解由**第二套**穷举器复核"，
// 所以这里两套的枚举形状必须不同，而不是同一函数换个名字：
//   countByRegion()  —— 按区域枚举：每块区域里挑两格（C(|R|,2) 种），逐块往下走，
//                       靠"任何黑格的邻居度数不许 >1"这条单调性剪枝。
//   countByBitmask() —— 整盘枚举：2^(w*h) 个落子全过一遍，判"黑格按 4-连通分组后
//                       每组恰两格 + 每区域恰两格"。它压根不知道 R1 的等价形式。
// 小盘上两套必须逐盘给同一个数（tests/counter-agree.test.mjs 钉这条），否则其中一套有洞。

import { buildAdjacency, regionsOf } from './grid.js';

export const DEFAULT_BUDGET = 4_000_000;

// 每区域两格的所有选法（区域格数升序取 pair，顺序固定 ⇒ 决定论）。
function pairsOfRegion(cells) {
  const out = [];
  for (let i = 0; i < cells.length; i += 1) {
    for (let j = i + 1; j < cells.length; j += 1) out.push([cells[i], cells[j]]);
  }
  return out;
}

/**
 * 枚举的核心。两种用法共用同一棵树：
 *   countByRegion()  —— 数到底，count 是真答案（exhausted=true 时）。
 *   findSolutions()  —— 拿到 want 条就收工，用于"给我另一条解当靶子"，不报总数。
 *                       给它 not=B 就是"除了 B 还有没有别的解"：找到=还有，数完=没了。
 *                       这一条同时是挖唯一解的靶子和收尾证明，不必再单独数一遍。
 * 返回 { count, atLeast, nodes, exhausted, solutions, abort }：
 *  - exhausted=false 表示没数完（预算用尽 abort='budget'，或按 want 提前收工 abort='want'）、
 *    **这个 count 不是答案**，只保证"已经数到 >=count 个解"。
 *    半路的 count 可能是 1，但"还没数完"和"数出来是 1"是两件事——调用方必须先看 exhausted。
 *  - solutions 是至多 want 条落子的拷贝。挖唯一解的那一步要拿"另一条解"当靶子，
 *    只报个数的计数器没法指导修改。
 *
 * 搜索顺序：不是 0..k-1 的区域号顺序，而是**优先沿已落子区域的邻边往前推**。
 * 这条不是性能调味：R1 的约束只在相邻区域之间传播，按号序走会让大半棵树互不相干地展开，
 * 8x8 实测按号序 3,000,000 结点仍数不完，沿邻边同样的盘只要 ~10^5（本机 2026-09-29）。
 */
function enumerate(reg, w, h, opts) {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const want = opts.want ?? 2;
  const stopEarly = !!opts.stopEarly;
  // not：排除条。给了它，count 就只数"**除了它之外**的解"——exhausted && count===0
  // 读作"它是唯一的解"，exhausted===false && count>=1 读作"还有别的解，这条就是"。
  const not = opts.not || null;
  const adj = buildAdjacency(w, h);
  const regions = regionsOf(reg, w, h);
  const choices = regions.map(pairsOfRegion);
  const black = new Uint8Array(w * h);
  // regionDone[i]=1 ⇒ 第 i 格所属区域已经处理完 ⇒ 除已定的两格外它此生不会再变黑。
  const regionDone = new Uint8Array(w * h);
  // 区域邻接表：两块区域只要有一对相邻格就连边。
  const radj = regions.map(() => new Set());
  for (let i = 0; i < w * h; i += 1) {
    for (const nb of adj[i]) {
      if (reg[nb] !== reg[i]) radj[reg[i]].add(reg[nb]);
    }
  }
  let nodes = 0;
  let count = 0;
  let abort = null;
  const solutions = [];

  const deg = (i) => {
    let d = 0;
    for (const nb of adj[i]) if (black[nb]) d += 1;
    return d;
  };
  // 当前落子是否和排除条逐格相同。
  const sameAs = (other) => {
    for (let i = 0; i < black.length; i += 1) if (black[i] !== other[i]) return false;
    return true;
  };
  // x 黑而孤立，且它每个邻居的区域都已处理完 ⇒ 再没有格子能陪它，R1 注定违反。
  const deadAlone = (i) => {
    if (deg(i) > 0) return false;
    for (const nb of adj[i]) if (!regionDone[nb]) return false;
    return true;
  };
  const place = (rid, pair) => {
    const [a, b] = pair;
    black[a] = 1;
    black[b] = 1;
    for (const c of regions[rid]) regionDone[c] = 1;
    if (deg(a) > 1 || deg(b) > 1 || deadAlone(a) || deadAlone(b)) {
      unplace(rid, pair);
      return false;
    }
    return true;
  };
  const unplace = (rid, pair) => {
    black[pair[0]] = 0;
    black[pair[1]] = 0;
    for (const c of regions[rid]) regionDone[c] = 0;
  };

  const order = regionOrder(regions.length, radj, choices);

  const dfs = (depth) => {
    nodes += 1;
    if (nodes > budget) { abort = 'budget'; return false; }
    if (depth === order.length) {
      // 收尾：所有格都定了，任何黑格都不许还是孤的（deg 已在过程中保证 ≤1）。
      for (let i = 0; i < black.length; i += 1) if (black[i] && deg(i) !== 1) return true;
      if (not && sameAs(not)) return true; // 排除条：B 是已知解，"除 B 之外还有吗"才是我们要问的
      count += 1;
      if (solutions.length < want) solutions.push(Uint8Array.from(black));
      if (stopEarly && count >= want) { abort = 'want'; return false; }
      return true;
    }
    const rid = order[depth];
    for (const pair of choices[rid]) {
      if (!place(rid, pair)) continue;
      const ok = dfs(depth + 1);
      unplace(rid, pair);
      if (!ok) return false;
    }
    return true;
  };

  const finished = dfs(0) && abort === null;
  return {
    count: finished ? count : null,
    atLeast: count,
    nodes,
    exhausted: finished,
    abort: finished ? null : abort,
    solutions,
    regionCount: regions.length,
  };
}

export function countByRegion(reg, w, h, opts = {}) {
  return enumerate(reg, w, h, { ...opts, want: opts.want ?? 2, stopEarly: false });
}

// "给我至多 want 条解，拿到就走"：挖唯一解的循环只关心"还有没有第二条"，
// 数到底在这种盘上动辄百万结点，而提前收工通常几百步就够。
export function findSolutions(reg, w, h, opts = {}) {
  return enumerate(reg, w, h, { ...opts, want: opts.want ?? 2, stopEarly: true });
}

// 区域处理顺序：先挑选法最少的，之后优先挑与已处理区域相邻的那块（同分时仍按选法数）。
// 邻边相连是关键——R1 只在相邻区域之间传播，把相邻的两块排在前后才能第一时间顶死；
// 按区域号顺序走，大半棵树会互不相干地展开（8x8 实测按号序 3,000,000 结点仍数不完）。
function regionOrder(k, radj, choices) {
  const left = new Set(Array.from({ length: k }, (_, i) => i));
  const touch = new Int32Array(k);
  const out = [];
  while (left.size) {
    let best = -1;
    let bestTouch = -1;
    let bestChoices = Infinity;
    for (const id of left) {
      const c = choices[id].length;
      if (touch[id] > bestTouch || (touch[id] === bestTouch && c < bestChoices)) {
        best = id; bestTouch = touch[id]; bestChoices = c;
      }
    }
    out.push(best);
    left.delete(best);
    for (const nb of radj[best]) touch[nb] += 1;
  }
  return out;
}


/**
 * 整盘 2^n 暴力（只用于小盘对账）。刻意不复用 R1 的等价形式：
 * 这里显式地把黑格做 4-连通分组，要求每组恰两格。
 */
export function countByBitmask(reg, w, h, opts = {}) {
  const maxCells = opts.maxCells ?? 20;
  const n = w * h;
  if (n > maxCells) {
    return { ok: false, why: `整盘枚举 ${n} 格 = 2^${n}，超过 maxCells=${maxCells} 的授权范围` };
  }
  const regions = regionsOf(reg, w, h);
  const adj = buildAdjacency(w, h);
  const black = new Uint8Array(n);
  let count = 0;
  let masks = 0;

  for (let m = 0; m < (1 << n); m += 1) {
    masks += 1;
    let ones = 0;
    for (let i = 0; i < n; i += 1) {
      black[i] = (m >> i) & 1;
      ones += black[i];
    }
    if (ones !== regions.length * 2) continue; // R2 要求每区域两格 ⇒ 总数固定，先砍掉绝大多数
    let bad = false;
    for (const cells of regions) {
      let c = 0;
      for (const x of cells) c += black[x];
      if (c !== 2) { bad = true; break; }
    }
    if (bad) continue;
    // R1 的原始说法：黑格按 4-连通分组，每组必须恰两格。
    const seen = new Uint8Array(n);
    for (let i = 0; i < n && !bad; i += 1) {
      if (!black[i] || seen[i]) continue;
      const stack = [i];
      seen[i] = 1;
      let size = 0;
      while (stack.length) {
        const cur = stack.pop();
        size += 1;
        for (const nb of adj[cur]) {
          if (black[nb] && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
        }
      }
      if (size !== 2) bad = true;
    }
    if (!bad) count += 1;
  }
  return { ok: true, count, masks, exhausted: true, nodes: masks };
}
