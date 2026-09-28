// 出题 worker：把 attempt 链放在另一条线程上跑。
//
// 为什么必须搬出去：硬骨档单次 attempt 的实测尾巴是 0.6～2.3 秒（DESIGN §七，150 次标定样本），
// 主线程同步等就是把界面钉死——浏览器闸里那条"生成期间页面还在响应"的断言判的就是这件事。
//
// 这个文件**自己数尝试次数**：循环体是 `attempt(tier, derive(seed, `${tier.key}#${i}`))`，
// 与 js/engine/generate.js 里 generate() 的那两行一模一样。这是有意的重复，不是偷懒——
// 浏览器闸拿这条链的产物去对 generate() 的产物，逐张盘比较。
// 两处共用一个函数就没有"壳里那套出题与引擎里那套出题是不是同一件事"这个证人，
// 而这一族漂移（壳自己改过种子派生）恰恰是最难从页面上看出来的那种。

import { TIERS, tierByKey, attempt } from './engine/generate.js';
import { derive } from './engine/rng.js';

const MAX_ATTEMPTS = 4000; // 与 generate() 的默认值同一条口径，改一边就得改另一边

function run(tier, seed, maxAttempts) {
  const reasons = {};
  for (let i = 0; i < maxAttempts; i += 1) {
    const a = attempt(tier, derive(seed, `${tier.key}#${i}`));
    if (a.ok) {
      return {
        ev: 'ok',
        tierKey: tier.key,
        seed,
        attemptNo: i, // 第 i 次尝试出货（0 起算），页面上念的是 i+1 张候选盘
        attempts: i + 1,
        w: a.w,
        h: a.h,
        reg: Array.from(a.reg),
        solution: Array.from(a.solution),
        metrics: a.metrics,
      };
    }
    reasons[a.reason] = (reasons[a.reason] || 0) + 1;
    if (i % 5 === 0 || reasons[a.reason] === 1) {
      postMessage({ ev: 'progress', tierKey: tier.key, seed, attempts: i + 1, reason: a.reason, reasons });
    }
  }
  return { ev: 'empty', tierKey: tier.key, seed, attempts: maxAttempts, reasons };
}

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.cmd !== 'generate') return;
  const tier = tierByKey(msg.tierKey);
  if (!tier) {
    postMessage({ ev: 'error', reqId: msg.reqId, reason: 'unknown-tier', tierKey: msg.tierKey, tiers: TIERS.map((t) => t.key) });
    return;
  }
  const seed = (Number(msg.seed) >>> 0) || 1;
  const maxAttempts = Number.isInteger(msg.maxAttempts) && msg.maxAttempts > 0 ? msg.maxAttempts : MAX_ATTEMPTS;
  const out = run(tier, seed, maxAttempts);
  postMessage({ ...out, reqId: msg.reqId });
};
