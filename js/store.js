// 存档只住一个键：norinori.save.v1。
//
// 为什么"当前这局"和"跨局的账"共用一个键：分两个键就会有"局面恢复了、账却回滚到上一局"
// 这种半对状态，而半对的存档比没有存档更坏——它会让玩家相信自己已经输过。
//
// resume 存的是**剖分本身**（regStr）而不是"种子 + 第几次尝试"：
// 后者要靠重跑整条尝试链才能拿回同一张盘，既要把出题的尾巴时间再花一遍，
// 又会在造题顺序被动过之后静默变成另一张盘。存下来才是"这一局"。
//
// 这个文件不 import 引擎：它只管字节进出，判定（这张盘合不合法）交回 main.js 用
// js/engine/grid.js 的 validatePartition 去做。存储层自己发明一套"合法"就是第二份真相。

export const SAVE_KEY = 'norinori.save.v1';
export const SAVE_VERSION = 1;

const MARKS_OK = '.#o';

export function emptyTotals() {
  return { games: 0, solved: 0, moves: 0, hints: 0 };
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    // 隐私模式 / 被策略禁掉的存储：这是浏览器给的边界，不是我们的 bug。
    return null;
  }
}

const isUint = (v) => Number.isInteger(v) && v >= 0;

// 一份会被接受的数据必须整个形状都对：任何一处对不上就当它不存在。
// 这里不"尽量修一修"——修出来的 resume 会让玩家对着一张他没玩过的盘继续落子。
function okResume(r) {
  if (r === null || typeof r !== 'object') return false;
  if (!isUint(r.w) || !isUint(r.h) || r.w < 1 || r.h < 1) return false;
  if (typeof r.regStr !== 'string' || typeof r.marks !== 'string') return false;
  const reg = r.regStr.split(',');
  if (reg.length !== r.w * r.h) return false;
  if (reg.some((s) => !/^\d+$/.test(s))) return false;
  if (r.marks.length !== r.w * r.h) return false;
  if ([...r.marks].some((c) => !MARKS_OK.includes(c))) return false;
  if (typeof r.tierKey !== 'string' || !r.tierKey) return false;
  if (typeof r.seed !== 'string' && !isUint(r.seed)) return false;
  if (!isUint(r.attemptNo)) return false;
  if (!isUint(r.moves) || !isUint(r.hints) || !isUint(r.elapsedMs)) return false;
  if (!isUint(r.at)) return false;
  return true;
}

// Object.keys 不是 Object.values：拿值列表来当键名查，t[0] 永远是 undefined，
// 于是"账"这一形状从来没有通过过校验——写进去的每次都被 okShape 拒了，
// 读的时候又因为 okShape 不过被当场抹掉。浏览器闸第一条真落子就撞上了它。
function okTotals(t) {
  if (t === null || typeof t !== 'object') return false;
  return Object.keys(emptyTotals()).every((k) => isUint(t[k]));
}

function okShape(data) {
  if (data === null || typeof data !== 'object') return false;
  if (data.version !== SAVE_VERSION) return false;
  if (!okTotals(data.totals)) return false;
  if (data.resume !== null && !okResume(data.resume)) return false;
  return true;
}

// 读一次。坏档一律读成"没有档"，并且把它抹掉：留着只会让玩家每次刷新都看见同一个谎。
export function load() {
  const s = storage();
  if (!s) return { resume: null, totals: emptyTotals(), available: false };
  let raw = null;
  try {
    raw = s.getItem(SAVE_KEY);
  } catch {
    return { resume: null, totals: emptyTotals(), available: false };
  }
  if (raw === null) return { resume: null, totals: emptyTotals(), available: true };
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!okShape(data)) {
    try {
      s.removeItem(SAVE_KEY);
    } catch {
      // 抹不掉也照样当没有：写的时候还会再红一次。
    }
    return { resume: null, totals: emptyTotals(), available: true };
  }
  return { resume: data.resume, totals: data.totals, available: true };
}

// 整体写入：调用方给哪一块就换哪一块，另一块从磁盘上读回来接着用。
export function save(patch) {
  const s = storage();
  if (!s) return false;
  const cur = load();
  const next = {
    version: SAVE_VERSION,
    resume: 'resume' in patch ? patch.resume : cur.resume,
    totals: 'totals' in patch ? patch.totals : cur.totals,
  };
  if (!okShape(next)) return false;
  try {
    s.setItem(SAVE_KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  return true;
}

// 交来一份对不上的档 ⇒ 这次写入**不发生**。
// 原先写的是 okResume(r) ? r : null，也就是"降级成没有档再写盘"：调用方哪里算错一个字段，
// 玩家已有的存档就被这一次静默抹掉，而调用方还拿到过——这正是文件头说的"半对比没有更坏"。
export function saveResume(resume) {
  if (!okResume(resume)) return false;
  return save({ resume });
}

export function clearResume() {
  return save({ resume: null });
}

export function addTotals(patch) {
  const next = { ...load().totals };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in next) || !Number.isInteger(v)) return false;
    next[k] = Math.max(0, next[k] + v);
  }
  return save({ totals: next });
}
