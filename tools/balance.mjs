#!/usr/bin/env node
// 难度实测（balance）：把 package.json description 与 DESIGN §九 里那几句承诺变成**会红的线**。
// 量的是：出货率 / 墙钟基线 / 唯一性证明结点数 / 链条深度分布 / 形状不变量 / 阶梯单调性。
//
// 与同目录别的工具的分工（不重复）：
//   rule-test / counter-test / solver-test 答"引擎有没有坏"。
//   generate-test 答"出货那一张是不是真的唯一、真的推得完、读数是不是真的"。
//   generator-probe 是观测器：只把账打出来，不判难度。
//   本文件答"这一档还是不是同一族盘、还配不配这个价"——它判的是**分布与成本**，不是单张对错。
//
// 五条硬口径（本组织栽过的坑，逐条写死在这里）：
//   ① 墙钟判据一律**卡 p95，绝不卡"中位×2"**：出题墙钟是双峰的（一次就出货 ≈0.6ms、烧到几十次 ≈90ms），
//      中位基线会一绿一红。基线公式照本组织现行代码（抄代码不抄注释）：
//        band = [max(1, ⌊med×0.4⌋), max(lo+1, ⌈p95×1.6⌉)]、budgetMs = max(10, ⌈p95×4⌉ 向上取整到 10ms)
//      每轮把 中位 / p95 / 最慢 三个**绝对值**原样打印，不许只留比值。
//   ② 绝对线写死在下面两张表里：红了只许改尺寸/maxSize/cap/maxMoves 这些**出题配置**，
//      不许调大线、不许把 p95 换成中位、不许删判据。调线的唯一合法路径：先量、再写、注释里带实测值。
//      ANTI-DRIFT 那条会咬：写死的线松到实测公式值（⌈p95×4⌉）两倍以上就红。
//   ③ 缺线 = 不判 = 漏网，不是宽容：TIERS 里每一档都必须在两张表里有自己的绝对线，否则直接红。
//   ④ 链条深度是**量出来的**，不是目标：TIERS.chain 区间就是 [p10, p90]，所以按构造只该盖住八成观测。
//      判据因此是"命中率 ≥ 50%"（分布漂了的探测器），不是"每张都进带"——不合格盘出不了货，
//      进不了带只是"这一档的形状变了"。实测命中率每轮照打。
//   ⑤ 阶梯红线（这一族的命门）：难度靠尺寸、链条深度与约束咬合度三维一起分，所以
//        · TIERS.chain 的两个端点必须沿档位**不减**（这是配置，不抽样，永远评）；
//        · 实测 chain p50 必须沿档位不减，且 warmup < hard（严格）；
//        · 实测证明结点 med 必须沿档位**严格递增**。
//      第三条不是装饰：实测 chain p50 在 easy/standard/tricky 上并列成 9/9/9，只有结点 med
//      （54 / 164 / 466 / 1012 / 3146，300 张）把五档真正分开。这条红了说明档位退化成"盘大 = 难"。
//      **修法不是把线调松**，是把数报给老板。
//   ⑥ 尾统计量只在**标定样本量**上评（CALIBRATION_SAMPLES，就是下面线表 provenance 那一次）：
//      p50/med/p95 在 1~2 张盘上不是统计量。实测过这条线：--samples=25 时 tricky 与 hard 各只出货
//      1 张，nearest-rank p95 塌成"样本里的最大值"，于是拿单张盘的链深读出去判"hard 比 tricky 倒挂"，
//      拿被低估的结点 p95 去判 ANTI-DRIFT「写死的线太松」（本机 2026-09-29：50/100 次都在这一条上假红，
//      实测结点 p95 4,282 vs 标定样本 150 次量到的 19,491）。样本不够时这些判据**计数进 withheld 并打出来**，
//      RESULT 行自报 `samples=… withheld=…`，tools/check.mjs 那一边断言 withheld=0 ——
//      所以"快看看"模式不许冒充结论，也不存在"悄悄少评一条"。而"出货这条路断了"在小样本下依然是判据：
//      逐档的出货率归零那条照红，标定样本下还多加一条每档 ≥5 张的下限。
//
// 跑法：
//   node tools/balance.mjs                  正式跑（每档抽 150 次 attempt）
//   node tools/balance.mjs --samples=40      少抽一点（口径不变，nearest-rank p95 会跳到更尾的格）
//   node tools/balance.mjs --quiet           只打 RESULT 行
//   node tools/balance.mjs --calibrate       额外打印"绝对线建议值"，用于回填下面两张线表
//   node tools/balance.mjs --dose            压死两条线、挪空一个带、把最后两档倒过来喂阶梯：6 条红线必须全咬住
// 退出码：0 = 全绿；1 = 有红线。本文件只读引擎出口，不改引擎、不碰浏览器、不联网、不装包。
import { attempt, TIERS, KNOWN_REASONS } from '../js/engine/generate.js';
import { countByRegion } from '../js/engine/counter.js';
import { validatePartition } from '../js/engine/grid.js';
import { solve } from '../js/engine/solver.js';
import { derive } from '../js/engine/rng.js';
import { loadavg, cpus } from 'node:os';

const argOf = (name, dflt) => {
  const a = process.argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : String(dflt);
};
const QUIET = process.argv.includes('--quiet');
const CALIBRATE = process.argv.includes('--calibrate');
const DOSE = process.argv.includes('--dose');
const SAMPLES = Math.max(20, Number(argOf('samples', 150)) || 150);
const BUDGET = 400_000; // 出货配置本身（generate.js 里 dig/polish 的 budget），红线不许调大它
const NOW = () => Number(process.hrtime.bigint() / 1000n) / 1000;
// 标定样本量 = 下面两张线表 provenance 那一次（每档 150 次 attempt，出货 50/24/30/13/7 张）。
// 尾统计量（p50 / med / p95）只在达到这个样本量时评：见头部第 ⑥ 条——低于它时 nearest-rank
// 会塌成"样本里的最大那个"，那时候的"倒挂"与"线太松"都是抽样假象，不是难度事实。
const CALIBRATION_SAMPLES = 150;
const MIN_SHIPPED_FOR_TAIL = 5; // med/p95 至少要 5 张盘才叫统计量（⑥ 的那条下限）
const TAIL_OK = SAMPLES >= CALIBRATION_SAMPLES;
let withheld = 0; // 本轮**没评**的尾判据条数；RESULT 行自报，check.mjs 断言它为 0

// ── 绝对线表 ────────────────────────────────────────────────────────────
// 本机 2026-09-29 实测（Node v26.8.1、darwin arm64、load1 1.75、15 核；每档 150 次 attempt、
// 基准种子 20260932），线 = ⌈p95×4⌉→10ms / ⌈p95×4⌉→50 结点。观测值原样记在这里，
// 改任何出题配置（尺寸 / maxSize / cap / maxMoves / budget）都必须 --calibrate 重量后一起改：
//   warmup   4x4  出货 50/150=33.3%  墙钟 p95 1.36ms      nodes p95 103    max 103
//   easy     5x4  出货 24/150=16.0%  墙钟 p95 2.95ms      nodes p95 347    max 347
//   standard 6x4  出货 30/150=20.0%  墙钟 p95 6.28ms      nodes p95 1,056  max 1,422
//   tricky   5x5  出货 13/150= 8.7%  墙钟 p95 41.65ms     nodes p95 1,604  max 1,604
//   hard     6x6  出货  7/150= 4.7%  墙钟 p95 564.24ms    nodes p95 19,491 max 19,491
// 同一张表在 --samples=300（出货 103/45/66/22/12 张）复跑过一遍：墙钟 p95 1.18 / 3.19 / 7.42 / 41.53 / 773.17 ms、
// 结点 p95 103 / 258 / 950 / 1,249 / 19,491 —— 五条线全部仍然绿，且 hard 的线（2260ms）比 300 样本的公式值
// 3100ms **更紧**（只紧不松，允许）。链条深度区间因此也按 300 样本重钉进 TIERS（见 js/engine/generate.js 头上那张表）。
// 两条实测事实要写在这里，别拿假设当结论：
//   · 墙钟沿档位跨三个量级（1.4ms → 564ms），最慢一次 attempt 是 2,301ms（hard）。
//     ⇒ 6x6 出货不能同步等：界面那一步必须异步 + 报"已检查 N 张候选盘"，而不是把线抬上去。
//   · 证明结点沿档位只涨两个量级（103 → 19,491），离 400,000 的预算还有 20 倍 ⇒ 唯一性这关便宜，
//     贵的是"挖到唯一"的搜索本身（丢弃原因里 not-promising 占 37~69%）。所以线盯 attempt 的尾巴，
//     不盯预算：预算动一次，下面所有档的线全部失配。
export const WALL_P95_LINE_MS = {
  warmup: 10, easy: 20, standard: 30, tricky: 170, hard: 2260,
};
export const PROOF_NODES_P95_LINE = {
  warmup: 450, easy: 1400, standard: 4250, tricky: 6450, hard: 78000,
};

const f2 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const f0 = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : String(x));
const sortedAsc = (a) => [...a].sort((x, y) => x - y);
// nearest-rank 分位数：sortedAsc[⌈q·n⌉-1]（小样本会跳到更尾的格，所以线只能在正式样本量上定）
const quantile = (asc, q) => (asc.length ? asc[Math.max(0, Math.ceil(q * asc.length) - 1)] : NaN);
const ceilTo = (x, step) => Math.ceil(x / step) * step;

function wallBaseline(medMs, p95Ms) {
  const lo = Math.max(1, Math.floor(medMs * 0.4));
  const hi = Math.max(lo + 1, Math.ceil(p95Ms * 1.6));
  return { lo, hi, budgetMs: Math.max(10, ceilTo(p95Ms * 4, 10)) };
}

let checks = 0;
const fails = [];
const add = (cond, msg) => {
  checks += 1;
  if (!cond) fails.push(msg);
};

/* ── 采样：每档 SAMPLES 次 attempt，逐次计时、出货盘记账 ───────────────── */
function sampleTier(tier) {
  const wallAsc = [];
  const chainAsc = [];
  const nodesAsc = [];
  const stepsAsc = [];
  const sizes = [];
  const reasons = {};
  let shipped = 0;
  let unknownShape = 0;
  const boards = []; // 出货盘的剖分留几张，供下面的唯一性/零猜测抽样复核
  for (let i = 0; i < SAMPLES; i += 1) {
    const t0 = NOW();
    const a = attempt(tier, derive(20260932, `bal:${tier.key}:${i}`), { digBudget: BUDGET });
    wallAsc.push(NOW() - t0);
    if (!a.ok) {
      const r = KNOWN_REASONS.includes(a.reason) ? a.reason : `未登记:${a.reason}`;
      reasons[r] = (reasons[r] || 0) + 1;
      if (r.startsWith('未登记')) unknownShape += 1;
      continue;
    }
    shipped += 1;
    chainAsc.push(a.metrics.chain);
    nodesAsc.push(a.metrics.proofNodes);
    stepsAsc.push(a.metrics.steps);
    sizes.push(a.metrics.sizes);
    if (boards.length < 3) boards.push({ reg: a.reg, solution: a.solution, metrics: a.metrics });
  }
  // 分位数一律走 nearest-rank（quantile 直接按下标取），所以这里先把四串读数排好。
  return {
    tier,
    wallAsc: sortedAsc(wallAsc),
    chainAsc: sortedAsc(chainAsc),
    nodesAsc: sortedAsc(nodesAsc),
    stepsAsc: sortedAsc(stepsAsc),
    sizes, reasons, shipped, unknownShape, boards,
  };
}

/* ── 逐档判定 + 打印 ──────────────────────────────────────────────────── */
const rows = TIERS.map(sampleTier);
const observed = [];

for (const m of rows) {
  const t = m.tier;
  const wallP95 = quantile(m.wallAsc, 0.95);
  const wallMed = quantile(m.wallAsc, 0.5);
  const nodesP95 = quantile(m.nodesAsc, 0.95);
  const nodesMax = m.nodesAsc.length ? sortedAsc(m.nodesAsc)[m.nodesAsc.length - 1] : NaN;
  const chainP10 = quantile(m.chainAsc, 0.1);
  const chainP50 = quantile(m.chainAsc, 0.5);
  const chainP90 = quantile(m.chainAsc, 0.9);
  const bl = wallBaseline(wallMed, wallP95);
  const inBand = m.chainAsc.filter((c) => c >= t.chain[0] && c <= t.chain[1]).length;
  const rate = m.chainAsc.length ? inBand / m.chainAsc.length : NaN;
  observed.push({ ...m, wallP95, wallMed, nodesMed: quantile(m.nodesAsc, 0.5), nodesP95, nodesMax, chainP10, chainP50, chainP90, bl, inBand, rate });

  const wl = WALL_P95_LINE_MS[t.key];
  const nl = PROOF_NODES_P95_LINE[t.key];
  add(Number.isFinite(wl), `${t.key}：墙钟绝对线缺失（缺线 = 不判 = 漏网）`);
  add(Number.isFinite(nl), `${t.key}：证明结点绝对线缺失`);
  add(m.unknownShape === 0, `${t.key}：出现没登记的丢弃原因 ${m.unknownShape} 次`);
  add(m.shipped >= 1, `${t.key}：${SAMPLES} 次 attempt 一张都没出货（出货率归零 = 通道断了）`);
  // 标定样本下，出货数本身也是判据：med/p95 的前提是"这一档的尾巴被抽到过"（⑥）。
  // 这条只会在**出货率掉到标定样本也抽不满 5 张**时红 —— 那是配置被动过，不是"运气差"。
  if (TAIL_OK) {
    add(m.shipped >= MIN_SHIPPED_FOR_TAIL,
      `${t.key}：标定样本 ${SAMPLES} 次只出货 ${m.shipped} 张（< ${MIN_SHIPPED_FOR_TAIL}）⇒ 这一档的 med/p95 不成其为统计量，⑥ 的样本前提破了（出货率崩 = 出题配置被动过）`);
  }
  if (Number.isFinite(wl)) add(wallP95 <= wl, `${t.key} 墙钟 p95 ${f2(wallP95)}ms > 线 ${wl}ms（红了改出题配置，不许把 p95 换成中位、不许抬线）`);
  if (Number.isFinite(nl)) add(nodesP95 <= nl, `${t.key} 证明结点 p95 ${f0(nodesP95)} > 线 ${f0(nl)}（同上，只许改 cap/maxMoves/尺寸）`);
  add(rate >= 0.5, `${t.key} 链深命中率 ${f2(rate * 100)}% < 50%（TIERS.chain=[${t.chain}] 已经不描述这一档的分布 ⇒ 尺寸或某段门槛被动过）`);
  // 形状不变量：每区 ≥2 格、≤maxSize，且区域数 = 黑格/2（这一档还是不是同一族盘）
  for (const s of m.sizes) {
    add(s.every((x) => x >= 2 && x <= t.maxSize), `${t.key}：出货剖分有区域大小越界：${s.join(',')}`);
  }
  // 唯一性/零猜测抽样复核（每档 3 张）。逐张复核是 tools/generate-test.mjs 的活，
  // 这里只盯"这一档出货的盘还数得完、还推得完"——分布变了它先红。
  for (let bi = 0; bi < m.boards.length; bi += 1) {
    const tag = `${t.key}：抽样第 ${bi + 1} 张`;
    const c = countByRegion(m.boards[bi].reg, t.w, t.h, { budget: BUDGET });
    add(c.exhausted && c.count === 1, `${tag} 的唯一性没数完或不是 1（count=${c.count} exhausted=${c.exhausted}）`);
    const run = solve(m.boards[bi].reg, t.w, t.h);
    add(run.complete && !run.contradiction, `${tag} 推不完（unknown=${run.unknown}）`);
    // 剖分与密度从**数组本身**验，不信自记读数（本组织吃过"出题器自己记的答案会说谎"的亏）
    const v = validatePartition(m.boards[bi].reg, t.w, t.h);
    add(v.ok, `${tag} 的剖分不自洽`, v.why || '');
    add(v.ok && v.sizes.every((s) => s >= 2 && s <= t.maxSize), `${tag} 有区域大小越界（上界 ${t.maxSize}）`);
    const black = m.boards[bi].solution.reduce((x, y) => x + y, 0);
    add(v.ok && black === 2 * v.regionCount, `${tag} 黑格数 ${black} ≠ 2×区域数 ${2 * v.regionCount}`);
    add(v.ok && black / (t.w * t.h) >= 2 / t.maxSize - 1e-9, `${tag} 密度低于 2/maxSize`);
  }
}

/* ── ⑤ 阶梯单调性 ─────────────────────────────────────────────────────── */
// 三条判据抽成函数：DOSE 那一路要拿**实测的两档倒过来**喂给它们，证明它们真会咬（写死的假值不算）。
const chainMonotone = (a, b) => b.chain[0] >= a.chain[0] && b.chain[1] >= a.chain[1];
const p50Monotone = (a, b) => Number.isFinite(a.chainP50) && Number.isFinite(b.chainP50) && b.chainP50 >= a.chainP50;
const nodesMonotone = (a, b) => Number.isFinite(a.nodesMed) && Number.isFinite(b.nodesMed) && b.nodesMed > a.nodesMed;

for (let i = 1; i < TIERS.length; i += 1) {
  const a = TIERS[i - 1];
  const b = TIERS[i];
  add(chainMonotone(a, b),
    `阶梯：${b.key} 的 chain 区间 [${b.chain}] 比 ${a.key} [${a.chain}] 低（档位退化或写串了）`);
  const oa = observed[i - 1];
  const ob = observed[i];
  // 两条实测尾判据：样本不到标定量就不评，但**计入 withheld** 并在 RESULT 行自报（⑥），
  // 于是"这一轮没评尾判据"是 CI 看得见的一条红，不是一个静默的分支。
  if (TAIL_OK) {
    add(p50Monotone(oa, ob),
      `阶梯：实测链深 p50 在 ${a.key}(${f2(oa.chainP50)}) → ${b.key}(${f2(ob.chainP50)}) 上倒挂`);
    // 梯子的第二维：证明结点的中位数 = 这张盘的约束咬得有多紧。实测五档严格递增
    // （54 / 164 / 466 / 1012 / 3146，300 样本），而 chain p50 有三档并列在 9，所以"相邻档真的更紧"
    // 这句话只有这一维撑得住 ⇒ 必须判它（出货下限在逐档那条已经保证）。
    add(nodesMonotone(oa, ob), `阶梯：${b.key} 的证明结点 med ${f0(ob.nodesMed)} 没有严格大于 ${a.key} 的 ${f0(oa.nodesMed)}（相邻档其实是同一族盘）`);
  } else {
    withheld += 2;
  }
}
{
  const first = observed[0];
  const last = observed[observed.length - 1];
  if (TAIL_OK) {
    add(Number.isFinite(first.chainP50) && Number.isFinite(last.chainP50) && last.chainP50 > first.chainP50,
      `阶梯：最低档与最高档的实测链深 p50 没有拉开（${f2(first.chainP50)} vs ${f2(last.chainP50)}）⇒ 五档其实是一族盘`);
  } else {
    withheld += 1;
  }
}

/* ── ② ANTI-DRIFT：写死的线松到实测公式值 2 倍以上 ⇒ 有人在调松线 ──────── */
// 判据要拿**尾巴**比，所以同样吃 ⑥ 的标定样本前提；低于标定量时计入 withheld（10 条），不静默。
if (TAIL_OK) {
  for (const m of observed) {
    add(WALL_P95_LINE_MS[m.tier.key] <= Math.max(10, ceilTo(m.wallP95 * 4, 10)) * 2,
      `ANTI-DRIFT 墙钟线：${m.tier.key} 写死 ${WALL_P95_LINE_MS[m.tier.key]}ms > 实测公式值 ⌈p95×4⌉→10ms=${Math.max(10, ceilTo(m.wallP95 * 4, 10))}ms 的 2 倍（实测 p95 ${f2(m.wallP95)}ms）⇒ 该红的是盘，不是线`);
    add(PROOF_NODES_P95_LINE[m.tier.key] <= Math.max(50, ceilTo(m.nodesP95 * 4, 50)) * 2,
      `ANTI-DRIFT 结点线：${m.tier.key} 写死 ${f0(PROOF_NODES_P95_LINE[m.tier.key])} > 实测公式值 ⌈p95×4⌉→50=${f0(Math.max(50, ceilTo(m.nodesP95 * 4, 50)))} 的 2 倍（实测 p95 ${f0(m.nodesP95)}）⇒ 同上`);
  }
} else {
  withheld += 2 * TIERS.length;
}

/* ── 打印 ─────────────────────────────────────────────────────────────── */
if (!QUIET) {
  const la = loadavg();
  console.log(`难度实测 · 每档 ${SAMPLES} 次 attempt · 基准种子 20260932 · 预算 ${BUDGET} 结点（出货配置本身）`);
  console.log(`本机 load1 ${la[0].toFixed(2)}、${cpus().length} 核 ⇒ 墙钟只当上界用`);
  for (const m of observed) {
    const t = m.tier;
    console.log(`\n[${t.key}] ${t.w}x${t.h} maxSize=${t.maxSize} chain=[${t.chain}]`);
    console.log(`   出货 ${m.shipped}/${SAMPLES} = ${f2((m.shipped / SAMPLES) * 100)}%｜丢弃 ${JSON.stringify(m.reasons)}`);
    console.log(`   墙钟 med ${f2(m.wallMed)} / p95 ${f2(m.wallP95)} / 最慢 ${f2(m.wallAsc[m.wallAsc.length - 1])} ms`
      + `｜基线 band=[${m.bl.lo}, ${m.bl.hi}]、budgetMs=${m.bl.budgetMs}ms｜绝对线 ${WALL_P95_LINE_MS[t.key]}ms ⇒ ${m.wallP95 <= WALL_P95_LINE_MS[t.key] ? '绿' : '红'}`);
    console.log(`   证明结点 med ${f0(quantile(m.nodesAsc, 0.5))} / p95 ${f0(m.nodesP95)} / max ${f0(m.nodesMax)}`
      + `｜绝对线 ${f0(PROOF_NODES_P95_LINE[t.key])} ⇒ ${m.nodesP95 <= PROOF_NODES_P95_LINE[t.key] ? '绿' : '红'}`);
    console.log(`   链深 p10 ${f2(m.chainP10)} / p50 ${f2(m.chainP50)} / p90 ${f2(m.chainP90)}`
      + `｜档内命中 ${m.inBand}/${m.chainAsc.length} = ${f2(m.rate * 100)}%（带 [${t.chain}] 按构造只盖八成）`);
    const sizeAll = [].concat(...m.sizes);
    console.log(`   区域大小 min ${Math.min(...sizeAll)} / max ${Math.max(...sizeAll)}（上界 ${t.maxSize}）`
      + `｜步数 p50 ${f2(quantile(m.stepsAsc, 0.5))}（= 全盘格数 ${t.w * t.h}）`);
  }
  console.log('\n── 阶梯（三维一起看：链深 p50 / 步数 p50 / 证明结点 med）──');
  console.log('   ' + observed.map((m) => `${m.tier.key} ${f2(m.chainP50)}/${f2(quantile(m.stepsAsc, 0.5))}/${f0(quantile(m.nodesAsc, 0.5))}`).join(' → '));
}

if (CALIBRATE) {
  console.log('\n── 绝对线建议值（⌈p95×4⌉→10ms / →50；回填上面两张表用，本文件不改引擎）──');
  for (const m of observed) {
    console.log(`   ${m.tier.key.padEnd(9)} 墙钟线 ${Math.max(10, ceilTo(m.wallP95 * 4, 10))}ms（实测 p95 ${f2(m.wallP95)}ms）`
      + `｜结点线 ${Math.max(50, ceilTo(m.nodesP95 * 4, 50))}（实测 p95 ${f0(m.nodesP95)} / max ${f0(m.nodesMax)}）`);
  }
}

/* ── 假绿探测器：把两条线压到不可能、把带挪到空区间、把两档倒过来喂阶梯 ─── */
if (DOSE) {
  console.log('\n── DOSE（注入不可能的假值 / 倒序的真值，看闸咬不咬）──');
  const before = fails.length;
  const fake = 'warmup';
  const origin = { wall: WALL_P95_LINE_MS[fake], nodes: PROOF_NODES_P95_LINE[fake] };
  const m0 = observed.find((x) => x.tier.key === fake);
  WALL_P95_LINE_MS[fake] = 0.001; // 任何真实墙钟都会越线
  add(m0.wallP95 <= WALL_P95_LINE_MS[fake], `DOSE：墙钟线被压到 ${WALL_P95_LINE_MS[fake]}ms 却没判红（闸咬不住）`);
  PROOF_NODES_P95_LINE[fake] = 0.001;
  add(m0.nodesP95 <= PROOF_NODES_P95_LINE[fake], `DOSE：结点线被压到 ${PROOF_NODES_P95_LINE[fake]} 却没判红（闸咬不住）`);
  const bandSwap = [9999, 10000];
  const inBandSwap = m0.chainAsc.filter((c) => c >= bandSwap[0] && c <= bandSwap[1]).length;
  add(inBandSwap / (m0.chainAsc.length || 1) >= 0.5, 'DOSE：把带挪到不可能的区间后命中率归零，说明这一条真的在数带内张数');
  // 阶梯三条：拿最后两档**倒过来**喂同一条判据（用的还是实测值，不是写死的假数）
  const hi = observed[observed.length - 1];
  const lo = observed[observed.length - 2];
  add(chainMonotone(hi.tier, lo.tier), 'DOSE：档位倒序时 chain 判据没咬住');
  add(p50Monotone(hi, lo), 'DOSE：档位倒序时链深 p50 判据没咬住');
  add(nodesMonotone(hi, lo), 'DOSE：档位倒序时证明结点判据没咬住');
  const fired = fails.length - before;
  console.log(`   注入 6 条假值/倒序 ⇒ 新红 ${fired} 条（>=6 才算闸咬得住）`);
  add(fired >= 6, `DOSE：注入 6 条只咬住 ${fired} 条 ⇒ 有判据是假绿`);
  WALL_P95_LINE_MS[fake] = origin.wall;
  PROOF_NODES_P95_LINE[fake] = origin.nodes;
  // 只摘掉那 6 条注入出来的红（它们是"闸咬得住"的证据，不是本轮成绩），上面那条 DOSE 元判据的红留着。
  fails.splice(before, fired);
}

console.log(`\n断言 ${checks} 条，红 ${fails.length} 条`);
if (withheld > 0) {
  console.log(`  ⚠ 另有 ${withheld} 条尾判据本轮**没评**：样本每档 ${SAMPLES} 次 < 标定 ${CALIBRATION_SAMPLES} 次（⑥）。`
    + `这一行不是结论，tools/check.mjs 那一边断言 withheld=0。`);
}
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT balance ok=${fails.length === 0} checks=${checks} fails=${fails.length} samples=${SAMPLES} withheld=${withheld}`);
process.exit(fails.length ? 1 : 0);
