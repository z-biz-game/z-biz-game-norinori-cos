// 出货路径：剖分 → 穷举计数器数到"恰 1 个解" → 照着求解器挪到"推得动" → 零猜测求解器推到底 → 量难度。
// 任何一步不过就丢这张盘、换下一个种子，**不许放宽**。
//
// 顺序是有理由的：计数器在前（它决定"这盘是不是一个谜题"），求解器在后
// （它决定"这盘是不是一个**不用猜**的谜题"）。反过来做的话，一张需要猜的盘
// 会被求解器判 incomplete 而丢掉，我们就永远量不到"计数器认为它唯一、但人推不动"
// 这一类，而这一类恰恰是难度梯子的上界所在。
// 中间那一步 polish 是后者的延伸：光"唯一"不够，还得"推得动"，而推不动的盘
// 在 5x5 以上是多数（本机 2026-09-29 实测：挖通的盘里 polish 前推得完的，6x4 是 2/7、5x5 是 0/5）。
//
// 求解器推完的那个 state 就是答案本身——不需要另外存：既然计数器已经证明全盘只有
// 一个解，而 checkSolution 验过这个 state 是解，那它必然**就是**那个解。
// 这句话是这仓最省事的正确性杠杆，所以它被写成 tests/shipping.test.mjs 里的一条断言。

import { makeRng, derive } from './rng.js';
import { checkSolution, validatePartition } from './grid.js';
import { makeShape, digToUnique, polishSolvable, formatPartition } from './partition.js';
import { solve, stateToBlack } from './solver.js';

// 档位表：尺寸 + 区域大小上界 + 链条深度区间。
// 唯一的形状旋钮是 maxSize：区域越大，每块 C(|R|,2) 的选法越多、骨牌之间的互相顶死越复杂。
// 实测下来 maxSize 不是难度旋钮而是可行性旋钮：同一尺寸下 ≤5 出货 17~33%、≤6 掉到 3~13%，
// 6x6 ≤6 直接 0/12（区域太少 → 替代解数超 cap，挖不动）。所以五档一律 ≤5，难度靠尺寸和链条深度分。
//
// chain 区间就是 tools/balance.mjs 每档 300 次 attempt 量出来的 [p10, p90]（本机 2026-09-29，
// Node v26.8.1 / darwin arm64 / load1 1.75 / 15 核，基准种子 20260932；同表还有出货率与单张耗时，
// 那是 tools/balance.mjs 那五条口径的观测来源）：
//   warmup   4x4  出货 103/300 = 34.3%  墙钟 med 0.49 / p95 1.18 ms      nodes med 54 / p95 103    p10 5 / p50 7 / p90 7   档内 92%
//   easy     5x4  出货  45/300 = 15.0%  墙钟 med 0.18 / p95 3.19 ms      nodes med 164 / p95 258   p10 7 / p50 9 / p90 11  档内 87%
//   standard 6x4  出货  66/300 = 22.0%  墙钟 med 0.38 / p95 7.42 ms      nodes med 466 / p95 950   p10 7 / p50 9 / p90 11  档内 80%
//   tricky   5x5  出货  22/300 =  7.3%  墙钟 med 0.44 / p95 41.53 ms     nodes med 1012 / p95 1249 p10 9 / p50 9 / p90 11  档内 95%
//   hard     6x6  出货  12/300 =  4.0%  墙钟 med 2.66 / p95 773 ms       nodes med 3146 / p95 19491 p10 9 / p50 12 / p90 16 档内 83%
// 档内命中不是 100% 是形状：[p10,p90] 天生只盖住八成观测，balance 拿它当"这一档还是同一族盘"的
// 指纹，命中掉了就是分布漂了（尺寸/门槛被动过），不是"有些盘不合格"——不合格盘根本出不了货。
// 改尺寸或改任何一段门槛，这两个数立刻失配。
//
// 梯子的实话（写在这里而不是藏进区间里）：**轮数这一维分不开五档**——easy/standard/tricky 的 p50
// 都是 9 轮，而盘的格数（= 求解器要落的步数）16/20/24/25/36 与证明结点 54/164/466/1012/3146
// 才是严格递增的两维。也就是说相邻档的差别在"要多想几步、约束咬得多紧"，不在"要来回推几轮"。
// balance 的阶梯红线因此同时盯这三条：chain 不减、chain p50 不减且首尾严格拉开、nodes med 严格递增。
export const TIERS = [
  { key: 'warmup', label: '热身', w: 4, h: 4, maxSize: 5, chain: [5, 7] },
  { key: 'easy', label: '入门', w: 5, h: 4, maxSize: 5, chain: [7, 11] },
  { key: 'standard', label: '标准', w: 6, h: 4, maxSize: 5, chain: [7, 11] },
  { key: 'tricky', label: '进阶', w: 5, h: 5, maxSize: 5, chain: [9, 11] },
  { key: 'hard', label: '硬骨', w: 6, h: 6, maxSize: 5, chain: [9, 16] },
];

export function tierByKey(key) {
  return TIERS.find((t) => t.key === key) || null;
}

// 丢弃原因的登记表：出货链上每一个"这盘不要了"的出口都必须在这里有个名字。
// tools/generate-test.mjs 拿它当门——出现没登记过的 reason 就红，所以新增一个失败出口
// 就得同时在这里登记、在文档里说明，不许悄悄多出一个没人认识的丢弃理由。
export const KNOWN_REASONS = [
  'shape',               // makeShape 长不出自洽剖分（区域大小/骨牌打包在这个尺寸下做不到）
  'not-promising',       // 开局那张盘的替代解数连预算都数不完，不是有指望的靶子
  'move-budget',         // 挪满 maxMoves 刀还没数到 0 条替代解
  'no-legal-move',       // 没有合法的刀可落了，但替代解仍在 cap 以上
  'needs-guess',         // 唯一但五条规则推不完（polish 抬不动格子数）
  'solver-contradiction',// 求解器在同一条盘上推出互相顶死的落子——引擎有洞，必须红
  'solution-invalid',    // 求解器推满了却不满足 R1/R2——同上
  'unknown-tier',        // 档位表里没有这个 key
  'exhausted-attempts',  // 整条尝试链走完都没出货
];

/**
 * 抽一张盘并走完四步。
 * @returns {{ok:true, reg, w, h, solution, metrics, stats} | {ok:false, reason, stats}}
 */
export function attempt(tier, seed, opts = {}) {
  const next = makeRng(derive(seed, `shape:${tier.key}`));
  const shape = makeShape(tier.w, tier.h, next, { maxSize: tier.maxSize });
  if (!shape.ok) return { ok: false, reason: 'shape', stats: { partitionRestarts: shape.restarts } };

  // 唯一性是挖出来的：拿"穷举器数出来的替代解条数"当靶子，一刀一刀让它变小，
  // 数到 0 的那一次本身就是穷举证明（探针只有走完整棵树才会承认"没凑够下一条"），
  // 所以出货前不用再数第二遍。B（构造时那条落子）全程挪不掉，所以 0 条替代读作恰 1 个解，不是 0 个。
  const dug = digToUnique(shape.reg, shape.black, tier.w, tier.h, makeRng(derive(seed, `dig:${tier.key}`)), {
    maxSize: tier.maxSize,
    budget: opts.digBudget ?? 400_000,
    cap: opts.digCap ?? tier.digCap ?? 48,
    maxMoves: tier.maxMoves ?? 300,
  });
  if (!dug.ok) {
    return {
      ok: false,
      reason: dug.why,
      altSolutions: dug.alts ?? dug.altsAtLeast ?? null,
      stats: { partitionRestarts: shape.restarts, moves: dug.moves, killed: dug.killed, rej: dug.rej },
    };
  }

  // 挖完只是"唯一"。接着在同一张盘上挪刀，把求解器能落定的格子数抬上去，
  // 每挪一刀都重新证明一次唯一（want=1 的替代解探针走完整棵树都没凑到下一条，就是穷举证明）。
  // plateau 必开：实测关掉它时 5x5/6x6 有 96~97% 的候选刀卡在"这一刀不涨格子数"上，一刀不中（0/9 推完），
  // 开了它 6x4 是 7/7 全推完（本机 2026-09-29，_tmp-polish 30 盘/档）。
  const polished = polishSolvable(shape.reg, shape.black, tier.w, tier.h,
    makeRng(derive(seed, `polish:${tier.key}`)), {
      maxSize: tier.maxSize,
      budget: opts.digBudget ?? 400_000,
      maxMoves: tier.polishMoves ?? 240,
      plateau: true,
    });

  const run = solve(shape.reg, tier.w, tier.h);
  if (run.contradiction) {
    return { ok: false, reason: 'solver-contradiction', stats: { nodes: dug.nodes, polishMoves: polished.moves } };
  }
  if (!run.complete) {
    return {
      ok: false,
      reason: 'needs-guess',
      stats: {
        partitionRestarts: shape.restarts,
        moves: dug.moves,
        nodes: dug.nodes,
        polishMoves: polished.moves,
        polishSteps: run.steps,
        unknown: run.unknown,
      },
    };
  }
  const solution = stateToBlack(run.state);
  const checked = checkSolution(solution, shape.reg, tier.w, tier.h);
  if (!checked.ok) return { ok: false, reason: 'solution-invalid', rule: checked.rule };

  const v = validatePartition(shape.reg, tier.w, tier.h);
  return {
    ok: true,
    w: tier.w,
    h: tier.h,
    reg: shape.reg,
    constructed: shape.black,
    solution,
    text: { partition: formatPartition(shape.reg, tier.w, tier.h) },
    metrics: {
      regionCount: v.regionCount,
      sizes: v.sizes,
      dominoes: shape.dominoes,
      chain: run.rounds,
      steps: run.steps,
      byRule: run.byRule,
      proofNodes: polished.nodes || dug.nodes,
      digMoves: dug.moves,
      polishMoves: polished.moves,
      blackCells: solution.reduce((a, b) => a + b, 0),
    },
    stats: { partitionRestarts: shape.restarts, nodes: dug.nodes, moves: dug.moves, polishMoves: polished.moves },
  };
}

/**
 * 决定论出题：种子 → 一张会红的盘或一个明确的失败原因。
 * 从 seed 派生第 i 次尝试的子种子，所以"换一局"永远是同一条链，能复现。
 */
export function generate(tierKey, seed, opts = {}) {
  const tier = typeof tierKey === 'string' ? tierByKey(tierKey) : tierKey;
  if (!tier) return { ok: false, reason: 'unknown-tier', tier: tierKey };
  const maxAttempts = opts.maxAttempts ?? 4000;
  const reasons = {};
  let restarts = 0;
  for (let i = 0; i < maxAttempts; i += 1) {
    const sub = derive(seed, `${tier.key}#${i}`);
    const a = attempt(tier, sub, opts);
    if (a.ok) {
      return {
        ...a,
        tier: tier.key,
        seed,
        attempts: i + 1,
        reason: null,
        stats: { ...a.stats, partitionRestarts: a.stats.partitionRestarts + restarts, reasons },
      };
    }
    restarts += (a.stats && a.stats.partitionRestarts) || 0;
    reasons[a.reason] = (reasons[a.reason] || 0) + 1;
  }
  return { ok: false, reason: 'exhausted-attempts', tier: tier.key, attempts: maxAttempts, reasons };
}
