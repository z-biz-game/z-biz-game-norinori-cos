// 盘面几何 + 两条规则的可执行形式。
//
// ── 规则（逐字来源见 DESIGN.md §一）────────────────────────────────────
// Nikoli 官方只有两条：
//   1. Place blocks in twos in consecutive black squares.
//   2. Each area surrounded by bold lines must contain two black squares.
// cross+A 把它展开成可判定的四句：每区域恰两黑格；每个黑格属于一个 1x2/2x1 骨牌，
// **骨牌可以跨过区域边界**；两个骨牌不得共边；可以共角。
// 两个源都没有"白格必须连通"这一条 ⇒ 本仓不实现它，也不拿它当判据（加一条没来源的规则，
// 穷举器就会去否掉真合法的解，那是一条会说谎的红线）。
//
// ── R1 的等价形式（本文件所有判定都走这条）──────────────────────────────
// "黑格两两成骨牌、骨牌之间不共边" ⟺ "每个黑格的 4-邻域里恰有一个黑格"。
//   ⇐：每个黑格恰一个黑邻居 ⇒ 黑格按 4-连通分组后每组是一条每个点度数为 1 的路，
//      在方格里只能是两个相邻格（2 个以上必出现度 2 的点；2x2 每点度 2）⇒ 组=骨牌，
//      且两组共边会让跨边那两个点各自多一个黑邻居。
//   ⇒：骨牌内部各贡献 1 个黑邻居；不共边保证没有第二个。
// 共角不受影响（对角不是 4-邻域）。这条等价在 tests/r1-equiv.test.mjs 里用**另一套**
// 显式骨牌枚举器逐盘对账，不靠上面这段推理自证。
//
// 表示：一维数组，行优先，idx = r*w + c。黑格用 0/1 的 Uint8Array。

export function cellIndex(w, r, c) {
  return r * w + c;
}

export function rowOf(i, w) {
  return (i / w) | 0;
}

export function colOf(i, w) {
  return i % w;
}

// 4-邻域，按 上右下左 固定顺序（顺序固定 ⇒ 任何用到它的产物都是决定论的）。
export function neighbors(i, w, h) {
  const r = rowOf(i, w);
  const c = colOf(i, w);
  const out = [];
  if (r > 0) out.push(i - w);
  if (c < w - 1) out.push(i + 1);
  if (r < h - 1) out.push(i + w);
  if (c > 0) out.push(i - 1);
  return out;
}

// 预生成整盘的邻接表：计数器是这段代码里跑得最多的，逐格现算邻域会把它拖慢一个量级。
export function buildAdjacency(w, h) {
  const n = w * h;
  const adj = new Array(n);
  for (let i = 0; i < n; i += 1) adj[i] = neighbors(i, w, h);
  return adj;
}

// 剖分 = 长度为 w*h 的区域号数组（0..k-1，必须连续无空洞）。
// 这里不生成剖分（那是 partition.js 的活），只负责"读懂并检查"。
export function regionsOf(reg, w, h) {
  const n = w * h;
  const k = Math.max(...reg) + 1;
  const cells = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i += 1) cells[reg[i]].push(i);
  return cells;
}

// 区域号数组是否自洽：号连续、覆盖全盘、每块内部 4-连通、且**至少两格**。
// "至少两格"是规则的直接后果（R2 要每块两黑格），不是审美选择：
// 一格区域永远满足不了 R2，留着它等于让计数器白跑一整轮。
export function validatePartition(reg, w, h) {
  const n = w * h;
  if (reg.length !== n) return { ok: false, why: `reg 长度 ${reg.length} ≠ w*h ${n}` };
  for (let i = 0; i < n; i += 1) {
    if (!Number.isInteger(reg[i]) || reg[i] < 0) return { ok: false, why: `第 ${i} 格区域号非法：${reg[i]}` };
  }
  const cells = regionsOf(reg, w, h);
  for (let id = 0; id < cells.length; id += 1) {
    if (!cells[id].length) return { ok: false, why: `区域号不连续：${id} 号没有任何格` };
  }
  for (let id = 0; id < cells.length; id += 1) {
    const list = cells[id];
    if (list.length < 2) return { ok: false, why: `${id} 号区域只有 ${list.length} 格，装不下两条黑格（R2）` };
    // 连通性：从第一格 BFS，只能走同区域格，看能不能吃满。
    const seen = new Set([list[0]]);
    const queue = [list[0]];
    while (queue.length) {
      const cur = queue.pop();
      for (const nb of neighbors(cur, w, h)) {
        if (reg[nb] === id && !seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    if (seen.size !== list.length) {
      return { ok: false, why: `${id} 号区域碎成 ${list.length - seen.size} 块孤岛（区域必须 4-连通）` };
    }
  }
  return { ok: true, regionCount: cells.length, sizes: cells.map((c) => c.length) };
}

// R1：每个黑格恰有一个黑邻居。返回违规格列表（空数组＝R1 成立）。
export function r1Violations(black, adj) {
  const bad = [];
  for (let i = 0; i < black.length; i += 1) {
    if (!black[i]) continue;
    let cnt = 0;
    for (const nb of adj[i]) if (black[nb]) cnt += 1;
    if (cnt !== 1) bad.push(i);
  }
  return bad;
}

// R2：每区域恰两黑格。
export function r2Violations(black, regions) {
  const bad = [];
  for (let id = 0; id < regions.length; id += 1) {
    let cnt = 0;
    for (const c of regions[id]) cnt += black[c];
    if (cnt !== 2) bad.push(id);
  }
  return bad;
}

// 完整判定一条落子。计数器与造解器都走这里，所以"什么算解"只有一份定义。
export function checkSolution(black, reg, w, h) {
  const adj = buildAdjacency(w, h);
  const v1 = r1Violations(black, adj);
  if (v1.length) return { ok: false, rule: 'R1', cells: v1 };
  const v2 = r2Violations(black, regionsOf(reg, w, h));
  if (v2.length) return { ok: false, rule: 'R2', regions: v2 };
  return { ok: true };
}

export function formatBoard(black, w, h) {
  const lines = [];
  for (let r = 0; r < h; r += 1) {
    let line = '';
    for (let c = 0; c < w; c += 1) line += black[r * w + c] ? '#' : '.';
    lines.push(line);
  }
  return lines.join('\n');
}
