#!/usr/bin/env node
// 规则表逐条验收。每张夹具都要过四道：
//   ① 剖分本身合法（≥2 格、4-连通、区域号连续）——夹具写坏了先在这里红；
//   ② **这一轮的事实全集**等于手推的那几条（等值比较，不是"包含"）：
//      多推一条 = 有不成立的推理；少推一条 = 规则表漏了必然事实；推错格 = 索引写坏了；
//      顺带把"规则 R 只在该出声的夹具上出声"钉死，不需要另写一张 silentOn 表。
//   ③ 每条期望事实都由**独立穷举计数器**复核：把这盘的全部解数完，凡与夹具已落子相容的解
//      都必须满足这条事实（= 它真是"必然"，不是启发式猜中），且相容解至少有一条（= 夹具不是死局）。
//   ④ 死局要报矛盾，而且报的位置（哪个区域/哪一格）是人写的那一处。
// 外加 RULES 表自洽（五条、每条有人话、每条都有夹具为它发声）。
import { deriveFacts, deriveOne, RULES, BLACK, WHITE } from '../js/engine/solver.js';
import { validatePartition, checkSolution, regionsOf } from '../js/engine/grid.js';
import { countByRegion } from '../js/engine/counter.js';
import { FIXTURES, DEAD, V, parseReg, parseMarks } from './fixtures.js';

let checks = 0;
const fails = [];
const notes = [];
function ok(cond, name, detail = '') {
  checks += 1;
  if (!cond) fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return !!cond;
}
const val = (v) => (v === BLACK ? 'B' : v === WHITE ? 'W' : '?');
const triple = (f) => `${f.cell}:${val(f.value)}:${f.rule}`;
const sorted = (a) => a.slice().sort();

// ③ 用：把这盘的全部解数完，只留与夹具已落子相容的那些。
function consistentSolutions(reg, w, h, state) {
  const all = countByRegion(reg, w, h, { want: 200_000 });
  if (!all.exhausted) return { err: `没数完（atLeast ${all.atLeast}，nodes ${all.nodes}）` };
  const keep = all.solutions.filter((sol) => {
    for (let i = 0; i < state.length; i += 1) {
      if (state[i] === BLACK && !sol[i]) return false;
      if (state[i] === WHITE && sol[i]) return false;
    }
    return true;
  });
  return { sols: keep, total: all.solutions.length };
}

/* ── ① 夹具自证 ── */
for (const fx of [...FIXTURES, ...DEAD]) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const v = validatePartition(reg, fx.w, fx.h);
  ok(v.ok, `夹具 ${fx.key} 的剖分必须合法`, v.why || '');
  const markCount = fx.reg.replace(/\//g, '').length;
  ok(markCount === fx.w * fx.h, `夹具 ${fx.key} 的串行数 × 列数要等于 w*h`, `${markCount} vs ${fx.w * fx.h}`);
}

/* ── ②③ 活夹具：事实全集 + 计数器复核 ── */
const rulesProven = new Set();
for (const fx of FIXTURES) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const state = parseMarks(fx.marks, fx.w, fx.h);
  const { facts, conflict } = deriveFacts(reg, fx.w, fx.h, state);
  ok(!conflict, `夹具 ${fx.key} 不该报矛盾`, conflict ? JSON.stringify(conflict) : '');
  const got = sorted(facts.map(triple));
  const want = sorted(fx.expect.map((e) => `${e.cell}:${e.value}:${e.rule}`));
  ok(got.length === want.length && got.every((t, i) => t === want[i]),
    `夹具 ${fx.key} 这一轮的事实全集必须等于手推的那 ${want.length} 条`,
    `得到 [${got.join(' ')}]｜期望 [${want.join(' ')}]`);
  for (const e of fx.expect) {
    ok(fx.key === 'SILENT' || e.rule in RULES, `夹具 ${fx.key} 引用了规则表外的 ${e.rule}`);
    rulesProven.add(e.rule);
  }

  const cs = consistentSolutions(reg, fx.w, fx.h, state);
  ok(!cs.err, `夹具 ${fx.key} 的独立计数器必须数完`, cs.err || '');
  const sols = cs.sols || [];
  ok(sols.length >= 1, `夹具 ${fx.key} 必须是活局（存在与已落子相容的解），否则"必然"是空话`,
    `全盘 ${cs.total} 条解，相容 0 条`);
  for (const e of fx.expect) {
    const bad = sols.filter((s) => s[e.cell] !== (e.value === 'B' ? 1 : 0));
    ok(bad.length === 0, `夹具 ${fx.key}：期望事实「第 ${e.cell} 格 ${e.value}（${e.rule}）」必须被每一条相容解支持`,
      `${bad.length}/${sols.length} 条解反对｜反例 ${bad.length ? bad[0].join('') : ''}`);
  }
  notes.push(`${fx.key}：全盘 ${cs.total ?? '-'} 条解、相容 ${sols.length} 条，本轮事实 ${facts.length} 条（${sorted(facts.map((f) => f.rule)).join('/') || '无'}）`);
}

/* ── ④ 死局：矛盾出口 ── */
for (const fx of DEAD) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const state = parseMarks(fx.marks, fx.w, fx.h);
  const { facts, conflict } = deriveFacts(reg, fx.w, fx.h, state);
  ok(!!conflict, `死局 ${fx.key} 必须报矛盾`, `facts=${facts.length} conflict=${JSON.stringify(conflict)}`);
  ok(facts.length === 0, `死局 ${fx.key} 报了矛盾就不许再吐事实（调用方会当"还能推"接着走）`, `${facts.length} 条`);
  if (conflict) {
    if ('region' in fx.where) ok(conflict.region === fx.where.region,
      `死局 ${fx.key} 的矛盾要点名 ${fx.where.region} 号区域`, `报了 ${conflict.region}（${conflict.why}）`);
    if ('cell' in fx.where) ok(conflict.cell === fx.where.cell,
      `死局 ${fx.key} 的矛盾要点名第 ${fx.where.cell} 格`, `报了 ${conflict.cell}（${conflict.why}）`);
    ok(typeof conflict.why === 'string' && conflict.why.length > 8, `死局 ${fx.key} 的矛盾要说得成人话`, conflict.why || '');
  }
  // 死局之所以是死局，不由引擎自证：相容解必须为 0 条
  const cs = consistentSolutions(reg, fx.w, fx.h, state);
  ok(!cs.err && cs.sols.length === 0, `死局 ${fx.key} 在独立计数器眼里也必须没有相容解`, `${cs.err || `相容 ${cs.sols.length} 条`}`);
  notes.push(`死局 ${fx.key}：${fx.why}`);
}

/* ── 规则表自洽 ── */
{
  const keys = Object.keys(RULES);
  ok(keys.length === 5, '规则表必须是那五条（多一条要有来源，少一条要说明为什么不再需要）', keys.join(','));
  for (const k of keys) {
    ok(typeof RULES[k] === 'string' && RULES[k].length > 8, `规则 ${k} 得有一句人话（提示直接念它）`, RULES[k] || '(缺)');
    ok(rulesProven.has(k), `规则 ${k} 必须有夹具为它发声`, '');
  }
  for (const fx of FIXTURES) {
    for (const e of fx.expect) ok(e.value === 'B' || e.value === 'W', `夹具 ${fx.key} 的期望值只能是 B/W`, e.value);
  }
}

/* ── 提示通道：deriveOne 只许给这一轮的真事实，且优先给能动手的那条 ── */
for (const fx of FIXTURES) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const state = parseMarks(fx.marks, fx.w, fx.h);
  const { facts } = deriveFacts(reg, fx.w, fx.h, state);
  const one = deriveOne(reg, fx.w, fx.h, state);
  if (!facts.length) {
    ok(one.fact === null && !one.conflict, `夹具 ${fx.key} 推不出东西时提示必须说"没有可证事实"`, JSON.stringify(one));
    continue;
  }
  ok(!!one.fact, `夹具 ${fx.key} 有 ${facts.length} 条可证事实，提示不该空手`, '');
  if (one.fact) {
    ok(facts.some((f) => f.cell === one.fact.cell && f.value === one.fact.value && f.rule === one.fact.rule),
      `夹具 ${fx.key} 的提示必须是本轮事实之一`, JSON.stringify(one.fact));
    const wantsBlack = facts.some((f) => f.value === BLACK);
    ok(!wantsBlack || one.fact.value === BLACK, `夹具 ${fx.key}：本轮有能落的黑格时提示要优先给黑格`, val(one.fact.value));
  }
}
for (const fx of DEAD) {
  const one = deriveOne(parseReg(fx.reg, fx.w, fx.h), fx.w, fx.h, parseMarks(fx.marks, fx.w, fx.h));
  ok(!!one.conflict, `死局 ${fx.key} 的提示通道必须报矛盾，不许回一句"再想想"`, JSON.stringify(one));
}

/* ── 出货路径的两套判定不能各说各话：夹具解经过 checkSolution 必须合法 ── */
for (const fx of FIXTURES) {
  const reg = parseReg(fx.reg, fx.w, fx.h);
  const state = parseMarks(fx.marks, fx.w, fx.h);
  const cs = consistentSolutions(reg, fx.w, fx.h, state);
  for (const s of (cs.sols || []).slice(0, 3)) {
    const c = checkSolution(s, reg, fx.w, fx.h);
    ok(c.ok, `夹具 ${fx.key} 的计数器解必须被 checkSolution 判合法（两套判据同一个口径）`, JSON.stringify(c));
  }
  const rs = regionsOf(reg, fx.w, fx.h).length;
  ok((cs.sols || []).every((s) => s.reduce((a, b) => a + b, 0) === 2 * rs),
    `夹具 ${fx.key}：每条解的黑格数都等于 2×区域数`, '');
}

for (const n of notes) console.log(`  · ${n}`);
console.log(`\n规则表：${Object.keys(RULES).join(' / ')}｜夹具 ${FIXTURES.length} 张 + 死局 ${DEAD.length} 张`);
console.log(`断言 ${checks} 条，红 ${fails.length} 条`);
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`RESULT rule-test ok=${fails.length === 0} checks=${checks} fails=${fails.length}`);
process.exit(fails.length ? 1 : 0);
