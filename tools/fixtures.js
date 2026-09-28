// 夹具表：tools/rule-test.mjs 与 tests/ 共用的手写局面。
//
// 每个夹具 = 一张剖分 + 一段已经落了一部分子的局面 + **手推出来的**这一轮该推出的事实全集。
// 期望值是人写的（推理写在 note 里），不是从当前输出抄的：红了先查引擎，把当前输出抄成期望
// 就等于把这条规则从"可证事实"降格成"程序是这么写的"。
//
// 串的形状：
//   reg   行用 '/' 分隔，同一字母＝同一区域，行优先，字母按首次出现编号（A=0,B=1,…）
//   marks 长度 w*h，'#'＝已黑，'o'＝已白，'.'＝未定
import { resolve } from 'node:path';
import { BLACK, WHITE, UNKNOWN, RULES } from '../js/engine/solver.js';
import { checkSolution, validatePartition } from '../js/engine/grid.js';

export function parseReg(letters, w, h) {
  const rows = letters.split('/');
  if (rows.length !== h || rows.some((r) => r.length !== w)) {
    throw new Error(`夹具剖分串形状不对：要 ${h} 行、每行 ${w} 列，实为 ${rows.join('|')}`);
  }
  const map = new Map();
  const reg = new Int16Array(w * h);
  rows.join('').split('').forEach((ch, i) => {
    if (!map.has(ch)) map.set(ch, map.size);
    reg[i] = map.get(ch);
  });
  return reg;
}

export function parseMarks(marks, w, h) {
  if (marks.length !== w * h) throw new Error(`夹具落子串长度 ${marks.length} ≠ ${w * h}（${marks}）`);
  const state = new Uint8Array(w * h);
  for (let i = 0; i < marks.length; i += 1) {
    state[i] = marks[i] === '#' ? BLACK : marks[i] === 'o' ? WHITE : UNKNOWN;
  }
  return state;
}

export const V = { B: BLACK, W: WHITE };

// ── 手工点解盘：解的**每一条**都是人在纸上列出来的（note 就是那段枚举）────────
// 两套穷举器和求解器都拿它们当"不来自程序输出"的证人。
export const HAND = [
  {
    reg: 'AACC/CCCC/CCCC/CCBB', w: 4, h: 4,
    note: 'A={0,1}、B={14,15} 两块两格区域把 0、1、14、15 钉成黑格；C 的两黑只能落在 3、6、7、8、9、12 这六个'
      + '不与黑格为邻的格里，且必须互为邻格 ⇒ 手列四条：(3,7)、(6,7)、(8,9)、(8,12)。',
    sols: [[0, 1, 14, 15, 3, 7], [0, 1, 14, 15, 6, 7], [0, 1, 14, 15, 8, 9], [0, 1, 14, 15, 8, 12]],
  },
  {
    reg: 'AAAA/BBBA/BCDD/CCCC', w: 4, h: 4,
    note: 'D={10,11} 两格 ⇒ 10、11 必黑，于是 6、7、9、14、15 全白；B={4,5,6,8} 只剩 4、5、8 三格取二，'
      + '(4,8) 会让 8 与 12（C 的两黑之一）相邻顶死 ⇒ B={4,5}，A 随之只能取 (2,3)。唯一一条。',
    sols: [[2, 3, 4, 5, 10, 11, 12, 13]],
  },
];

// ── 五条规则：每条要一张"这一轮只推得出这一件事"的夹具 ──────────────────
export const FIXTURES = [
  {
    key: 'R2FULL',
    w: 4, h: 4,
    reg: 'AABB/AABB/CCDD/CCDD',
    marks: '##..............',
    note: 'A={0,1,4,5} 已经黑了 0、1 两格 ⇒ R2 说这块满了 ⇒ 4、5 只能是白的（R2-FULL）。'
      + '骨牌几何同一轮也开口：1 已经有了同伴 0，它另一个未定邻居 2 必须是白的（CLOSED）。'
      + 'LONER 沉默——所有未定格的邻居里都还有未定或已黑的格。',
    expect: [
      { cell: 4, value: 'W', rule: 'R2-FULL' },
      { cell: 5, value: 'W', rule: 'R2-FULL' },
      { cell: 2, value: 'W', rule: 'CLOSED' },
    ],
  },
  {
    key: 'R2LAST',
    w: 4, h: 4,
    reg: 'AACC/CCCC/CCCC/CCBB',
    marks: '................',
    note: 'A={0,1}、B={14,15} 是两块两格区域。R2 要每块恰两黑，两格的地盘上除了这两格没处可放 ⇒ 四格全黑（R2-LAST）。'
      + 'C 是剩下 12 格的大陆，本轮一条都推不出（0 黑 12 未定，名额比空格少）。'
      + '这是求解器唯一的开局种子来源：没有两格区域的盘，五条规则一步都迈不出去。',
    expect: [
      { cell: 0, value: 'B', rule: 'R2-LAST' },
      { cell: 1, value: 'B', rule: 'R2-LAST' },
      { cell: 14, value: 'B', rule: 'R2-LAST' },
      { cell: 15, value: 'B', rule: 'R2-LAST' },
    ],
  },
  {
    key: 'PARTNER',
    w: 4, h: 4,
    reg: 'AABB/AABB/CCDD/CCDD',
    marks: '#...o...........',
    note: '0 已黑，它的邻居只有 1 和 4 两个，而 4 已被判白 ⇒ 0 的同伴只剩 1 ⇒ 1 必黑（PARTNER）。'
      + 'A={0,1,4,5} 侧本轮不开口：0 黑、4 白，未定还剩 1、5 两格，差 1 个名额而空格有 2 个，R2-LAST 不成立。',
    expect: [{ cell: 1, value: 'B', rule: 'PARTNER' }],
  },
  {
    key: 'CLOSED',
    w: 4, h: 4,
    reg: 'AAAA/BBBA/BCDD/CCCC',
    marks: '......oo.o####oo',
    note: '12、13 已黑且互为同伴（骨牌只有两格长）⇒ 12 其余的邻居不能再黑 ⇒ 8 白（CLOSED）。'
      + '区域侧全沉默：D={10,11} 两黑且没有未定格，C={9,12,13,14,15} 的未定格是 0 个，A、B 名额少于空格。',
    expect: [{ cell: 8, value: 'W', rule: 'CLOSED' }],
  },
  {
    key: 'LONER',
    w: 6, h: 4,
    reg: 'AAABBB/AAABBB/CCCDDD/CCCDDD',
    marks: '........o....o.o....o...',
    note: '14=(2,2) 的四个邻居 8、13、15、20 全白了 ⇒ 它真黑下去也等不到同伴，违反 R1 ⇒ 14 只能白（LONER）。'
      + '四条区域/骨牌规则这轮都不开口：C 块还剩 12、14、18、19 四个未定而名额只有 2，D 块同理，没有黑格所以几何侧静默。',
    expect: [{ cell: 14, value: 'W', rule: 'LONER' }],
  },
  {
    key: 'SILENT',
    w: 4, h: 4,
    reg: 'AABB/AABB/CCDD/CCDD',
    marks: '................',
    note: '四块 2x2、全未定：区域侧 0 黑 4 未定（名额少于空格），几何侧没有黑格，LONER 没有全白的邻居 ⇒ 一条都推不出。'
      + '这张盘有解（例如 0、1、6、7、8、9、14、15 黑），但不动笔就没法写下第一格——需要猜的盘长这样。',
    expect: [],
  },
];

// ── 死局：矛盾必须报，而且只有该报的那一条报 ────────────────────────────
export const DEAD = [
  {
    key: 'region-over',
    w: 4, h: 4,
    reg: 'AABB/AABB/CCDD/CCDD',
    marks: '##..#...........',
    where: { region: 0 },
    why: 'A={0,1,4,5} 里 0、1、4 三黑 ⇒ 超过 R2 要求的 2 颗',
  },
  {
    key: 'region-starved',
    w: 4, h: 4,
    reg: 'AAAA/BBBB/CCDD/CCDD',
    marks: '....ooo.........',
    where: { region: 1 },
    why: 'B={4,5,6,7} 三格判白、零格已黑 ⇒ 只剩 1 格可黑，凑不满 R2 要求的 2 颗',
  },
  {
    key: 'squeeze',
    w: 4, h: 4,
    reg: 'AAAA/BBBB/CCDD/CCDD',
    marks: '##..#...........',
    where: { cell: 0 },
    why: '0 的邻居 1 和 4 都是黑的 ⇒ 一颗黑格挤进两颗黑格，两格长的骨牌放不下',
  },
  {
    key: 'same-round-clash',
    w: 4, h: 4,
    reg: 'AABB/AABB/CCDD/CCDD',
    marks: 'oo...##.........',
    where: { cell: 4 },
    why: 'R2-LAST 说 4 必黑（A 只剩 4、5 可黑而 5 已黑），CLOSED 说 4 必白（5 的同伴是 6）⇒ 同一轮两种判法',
  },
];

/* ── 直接跑本文件 = 夹具自检（tools/check.mjs 清单里的那一套）────────────
 * 这里只验夹具**自己**站不站得住：串的形状、格子下标、期望事实引用的规则名与区域号、
 * 手写解是否真的满足两条规则。不跑引擎的推理——那是 rule-test 的活。
 * 目的是：夹具写错（下标漂了、marks 少一位、引用了不存在的规则名）不能变成"引擎红"，
 * 而要在最早的那一站红。 */
const DIRECT = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (DIRECT) {
  let checks = 0;
  const fails = [];
  const ok = (cond, name, detail = '') => {
    checks += 1;
    if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  };
  for (const b of HAND) {
    const reg = parseReg(b.reg, b.w, b.h);
    const v = validatePartition(reg, b.w, b.h);
    ok(v.ok, `手工盘 ${b.reg}：剖分必须自洽`, v.why || '');
    ok(b.note.length > 20 && b.sols.length >= 1, `手工盘 ${b.reg}：必须有人写的推理与至少一条解`);
    for (const s of b.sols) {
      ok(new Set(s).size === s.length, `手工盘 ${b.reg}：解里有重复格`, s.join(','));
      ok(s.every((i) => Number.isInteger(i) && i >= 0 && i < b.w * b.h), `手工盘 ${b.reg}：解的下标越界`, s.join(','));
      ok(s.length === 2 * v.regionCount, `手工盘 ${b.reg}：每条解的黑格数必须是 2×区域数`, `${s.length} vs ${2 * v.regionCount}`);
      const black = new Uint8Array(b.w * b.h);
      for (const i of s) if (i >= 0 && i < black.length) black[i] = 1;
      ok(checkSolution(black, reg, b.w, b.h).ok, `手工盘 ${b.reg}：人列的这条解必须过两条规则`, s.join(','));
    }
  }
  for (const list of [FIXTURES, DEAD]) {
    const keys = new Set();
    for (const f of list) {
      ok(!keys.has(f.key), `夹具 key 重复：${f.key}`);
      keys.add(f.key);
      const reg = parseReg(f.reg, f.w, f.h);
      const v = validatePartition(reg, f.w, f.h);
      ok(v.ok, `夹具 ${f.key}：剖分必须自洽`, v.why || '');
      ok(f.marks.length === f.w * f.h, `夹具 ${f.key}：marks 长度必须等于 w·h`, `${f.marks.length}`);
      ok(typeof f.note === 'string' ? f.note.length > 20 : true, `夹具 ${f.key}：必须有人写的推理`);
      const state = parseMarks(f.marks, f.w, f.h);
      for (const e of f.expect || []) {
        ok(e.rule in RULES, `夹具 ${f.key}：期望事实引用了不存在的规则名「${e.rule}」`);
        ok(e.cell >= 0 && e.cell < f.w * f.h, `夹具 ${f.key}：期望事实的下标越界 ${e.cell}`);
        ok(state[e.cell] === UNKNOWN, `夹具 ${f.key}：期望事实那格在 marks 里必须还是未定（否则这条事实是抄来的）`, `${e.cell}=${state[e.cell]}`);
        ok(e.value === 'B' || e.value === 'W', `夹具 ${f.key}：期望值只能是 B/W`, `${e.value}`);
        if (typeof e.region === 'number') ok(e.region < v.regionCount, `夹具 ${f.key}：期望区域号越界 ${e.region}`);
      }
      if (f.where) {
        if ('region' in f.where) ok(f.where.region < v.regionCount, `死局 ${f.key}：where.region 越界`, `${f.where.region}/${v.regionCount}`);
        if ('cell' in f.where) ok(f.where.cell >= 0 && f.where.cell < f.w * f.h, `死局 ${f.key}：where.cell 越界`, `${f.where.cell}`);
        ok((f.why || '').length > 10, `死局 ${f.key}：必须写清为什么该矛盾`);
      }
    }
  }
  console.log(`夹具自检：手工盘 ${HAND.length} 张、规则夹具 ${FIXTURES.length} 张、死局 ${DEAD.length} 张`);
  console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log(`RESULT fixtures ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
  process.exit(fails.length ? 1 : 0);
}
