// 出货漏斗探针：每档抽 N 张盘，打印"死在哪一步"的比例与链条深度分布。
// 这张表是 README/DESIGN 里"难度是量出来的"那句话的原始出处，也是
// tools/balance.mjs 那十条红线的观测来源——所以它只报数，不判绿。
//
//   node tools/generator-probe.mjs            # 每档 240 张
//   NODE_PROBE_SAMPLES=1200 node tools/generator-probe.mjs
//
// 墙钟列会随机器负载漂，结构列（比例、深度、结点）不会。

import { TIERS, attempt } from '../js/engine/generate.js';
import { derive, makeRng } from '../js/engine/rng.js';

const SAMPLES = Number(process.env.NODE_PROBE_SAMPLES ?? 240);
const BASE_SEED = Number(process.env.NODE_PROBE_SEED ?? 20260929);

function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[i];
}

const rows = [];
for (const tier of TIERS) {
  const reasons = {};
  const chains = [];
  const nodes = [];
  let ok = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < SAMPLES; i += 1) {
    const seed = derive(BASE_SEED, `${tier.key}:${i}`);
    const r = attempt(tier, seed);
    if (r.ok) {
      ok += 1;
      chains.push(r.metrics.chain);
      nodes.push(r.metrics.proofNodes);
    } else {
      reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  chains.sort((a, b) => a - b);
  nodes.sort((a, b) => a - b);
  rows.push({
    tier: `${tier.key} ${tier.w}x${tier.h} ≤${tier.maxSize}`,
    samples: SAMPLES,
    ok,
    rate: `${((ok / SAMPLES) * 100).toFixed(1)}%`,
    ms: (ms / SAMPLES).toFixed(1),
    chain: chains.length ? `p10 ${quantile(chains, 0.1)} / p50 ${quantile(chains, 0.5)} / p90 ${quantile(chains, 0.9)} / max ${chains[chains.length - 1]}` : '—',
    nodes: nodes.length ? `p50 ${quantile(nodes, 0.5)} / p95 ${quantile(nodes, 0.95)} / max ${nodes[nodes.length - 1]}` : '—',
    band: `[${tier.chain[0]}, ${tier.chain[1]}]`,
    inBand: chains.length ? `${((chains.filter((c) => c >= tier.chain[0] && c <= tier.chain[1]).length / chains.length) * 100).toFixed(0)}%` : '—',
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((v / SAMPLES) * 100).toFixed(1)}%`).join(' · ') || '（无丢弃）',
  });
}

console.log(`出货漏斗 · 每档 ${SAMPLES} 抽 · 基准种子 ${BASE_SEED}`);
console.log('（makeRng 在这里只用来固定顺序，探针本身不额外抽随机数）');
for (const r of rows) {
  console.log(`\n▎${r.tier}  出货 ${r.ok}/${r.samples} = ${r.rate}  单张 ${(r.ms)}ms`);
  console.log(`   链条 rounds：${r.chain}   档内区间 ${r.band} 命中 ${r.inBand}`);
  console.log(`   计数结点：  ${r.nodes}`);
  console.log(`   丢弃原因：  ${r.reasons}`);
}

// 顺手确认 rng 是决定论的：同一 seed 两次抽出的序列必须逐位相同。
const a = makeRng(BASE_SEED);
const b = makeRng(BASE_SEED);
let same = true;
for (let i = 0; i < 1000; i += 1) if (a() !== b()) same = false;
console.log(`\n▎rng 决定论自检：1000 次同种子逐位${same ? '相同 ✔' : '不同 ✘'}`);
if (!same) process.exitCode = 1;
