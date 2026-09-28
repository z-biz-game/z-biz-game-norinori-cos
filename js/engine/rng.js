// 决定论随机源：同一个种子在 node 和 Chrome 里必须吐出同一张盘面，否则"复跑逐字相同"这句话
// 从第一行起就是假的。所以这里只有 32 位整数运算，没有 Math.random、没有浮点、没有 Date。
//
// mulberry32：状态是一个 uint32，一步四次移位/乘法，周期 2^32。选它是因为它在 V8 与 SpiderMonkey
// 里都只走 int32/uint32 路径，不存在"某引擎多算一位尾数"的余地。

export function makeRng(seed) {
  let s = (seed >>> 0) || 1; // 0 是 mulberry32 的不动点，必须避开
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 字符串 → uint32（FNV-1a）。种子句柄在 URL 里是 `6x6#3-a1b2c3…` 这种文本，得能跨引擎折成数。
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 从 (seed, tag) 派生一个子种子：剖分、造解、抽线索各用各的 tag，这样换掉其中一步
// 不会把另外两步的产物一起抖掉——复现某一张盘时这点很值钱。
export function derive(seed, tag) {
  return (seed ^ hashString(tag)) >>> 0;
}

// [0, n) 整数。n<=0 时返回 0，调用方自己保证范围。
export function randInt(next, n) {
  return Math.floor(next() * n);
}

// Fisher-Yates，就地。
export function shuffle(next, arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randInt(next, i + 1);
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}
