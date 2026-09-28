// 零猜测求解器：只许用"从当前盘面必然推出"的局部事实。
//
// 这个文件同时是三样东西的唯一实现：
//   1) 出货门槛 —— 一盘题必须被它**不靠猜**推到底，否则那张盘根本不进菜单（generate.js 直接丢）；
//   2) 提示 —— 玩家按 H 拿到的就是 deriveOne() 挑出的下一条可证事实，附带它自己的规则名，
//      所以"提示只给可证事实"这句话不需要额外保证，它和求解器是同一段代码；
//   3) 难度量纲 —— rounds / steps 这些读数就是 balance 梯子里被量的那个数。
//
// 规则表（每条都只读题面给的区域边界与已推出的格子，不读答案）：
//   R2-FULL   一个区域已有两黑 ⇒ 该区域其余格全白。
//   R2-LAST   一个区域还差 k 黑、且只剩 k 个未定格 ⇒ 这些格全黑。
//   PARTNER   黑格必须恰有一个黑邻居：邻居里只剩一个还可能变黑 ⇒ 它必黑。
//   CLOSED    黑格已经有了黑邻居 ⇒ 它其余邻居全白（骨牌只有两格长）。
//   LONER     某未定格四邻皆白 ⇒ 它自己不能是黑格（黑了就没同伴）⇒ 它必白。
// 五条都是**单向必然**，没有任何一条需要"试一下会怎样"。规则不完备是明说的边界
// （DESIGN §九）：推不完就判这盘需要猜、不出货，而不是给求解器加一条猜测。

import { buildAdjacency, regionsOf } from './grid.js';

export const UNKNOWN = 0;
export const BLACK = 1;
export const WHITE = 2;

export const RULES = {
  'R2-FULL': '这个区域已经有两颗黑格，剩下的格只能是白的',
  'R2-LAST': '这个区域还差的格只剩这么几个，必须全是黑格',
  PARTNER: '这颗黑格只剩一个邻居还可能变黑，它的同伴只能是那一格',
  CLOSED: '这颗黑格已经有了同伴，骨牌只有两格长，它四周其余邻居都是白的',
  LONER: '这一格四周已经全白，真黑下去就永远等不到同伴，所以它只能是白的',
};

export function initialState(n) {
  return new Uint8Array(n);
}

// 一次推导 = { cell, value, rule, region }。value 用 BLACK/WHITE。
function Fact(cell, value, rule, region) {
  return { cell, value, rule, region };
}

/**
 * 扫一遍全盘，返回这一轮能必然推出的新事实（不写回 state，调用方决定怎么写）。
 * 返回 { facts, conflict }：conflict 非空说明当前局面无解（规则不会在可解盘上触发它）。
 */
export function deriveFacts(reg, w, h, state) {
  const adj = buildAdjacency(w, h);
  const regions = regionsOf(reg, w, h);
  const facts = [];
  const seen = new Uint8Array(w * h); // 同一轮里同一格只记一次
  // 同一轮里两条规则指到同一格：值相同就合并，**值不同就是矛盾**，必须报出来。
  // 早先这里只有 `if (seen[f.cell]) return`，也就是先到先得、后者静默消失——
  // 一张死局因此会被当成"还能推"继续走，而它的真相是"这一步同时推出了黑和白"。
  const said = new Int8Array(w * h); // 0 = 本轮没提过这格，1=BLACK，2=WHITE
  let clash = null;
  const push = (f) => {
    if (clash) return;
    if (seen[f.cell]) {
      if (said[f.cell] !== f.value) {
        clash = { cell: f.cell, why: `同一轮里 ${f.rule} 与先前那条规则把这格同时判成黑与白` };
      }
      return;
    }
    seen[f.cell] = 1;
    said[f.cell] = f.value;
    facts.push(f);
  };

  // 区域计数
  for (let id = 0; id < regions.length; id += 1) {
    let black = 0;
    let unknown = 0;
    for (const c of regions[id]) {
      if (state[c] === BLACK) black += 1;
      else if (state[c] === UNKNOWN) unknown += 1;
    }
    if (black > 2) return { facts: [], conflict: { region: id, why: `区域里黑格数 ${black} 超过 R2 要求的 2` } };
    if (black + unknown < 2) return { facts: [], conflict: { region: id, why: `区域只剩 ${black + unknown} 格可能黑，凑不满 2 颗` } };
    if (black === 2) {
      for (const c of regions[id]) if (state[c] === UNKNOWN) push(Fact(c, WHITE, 'R2-FULL', id));
    }
    // 还差的黑格名额只剩这么几个未定格 ⇒ 它们全是黑的。写成 black+unknown===2 而不是
    // "unknown===2 且 black===0"：后者漏掉"已经黑了一个、只剩最后一格"的收尾，那条一样是必然。
    if (unknown > 0 && black + unknown === 2) {
      for (const c of regions[id]) if (state[c] === UNKNOWN) push(Fact(c, BLACK, 'R2-LAST', id));
    }
  }

  // 骨牌几何
  for (let i = 0; i < state.length; i += 1) {
    if (state[i] !== BLACK) continue;
    let open = 0;
    let openCell = -1;
    let partners = 0;
    for (const nb of adj[i]) {
      if (state[nb] === BLACK) partners += 1;
      else if (state[nb] === UNKNOWN) { open += 1; openCell = nb; }
    }
    if (partners > 1) return { facts: [], conflict: { cell: i, why: '一颗黑格周围挤进了两颗黑格，骨牌放不下' } };
    if (partners === 1) {
      for (const nb of adj[i]) if (state[nb] === UNKNOWN) push(Fact(nb, WHITE, 'CLOSED', reg[i]));
    } else if (open === 1) {
      push(Fact(openCell, BLACK, 'PARTNER', reg[i]));
    } else if (open === 0) {
      return { facts: [], conflict: { cell: i, why: '这颗黑格四周已经全白，等不到同伴' } };
    }
  }

  // LONER：未定格若四邻皆白（或已定），自己不能黑
  for (let i = 0; i < state.length; i += 1) {
    if (state[i] !== UNKNOWN) continue;
    let canPartner = 0;
    for (const nb of adj[i]) if (state[nb] !== WHITE) canPartner += 1;
    if (canPartner === 0) push(Fact(i, WHITE, 'LONER', reg[i]));
  }

  // 写回前先看有没有自相矛盾（同一格被两条规则判成不同值）
  if (clash) return { facts: [], conflict: clash };
  for (const f of facts) {
    if (state[f.cell] !== UNKNOWN && state[f.cell] !== f.value) {
      return { facts: [], conflict: { cell: f.cell, why: `${state[f.cell] === BLACK ? '已判黑' : '已判白'}的格又被判成另一种` } };
    }
  }
  return { facts, conflict: null };
}

/** 下一条可证事实（提示用）：优先给黑格，玩家更能立刻动手。 */
export function deriveOne(reg, w, h, state) {
  const { facts, conflict } = deriveFacts(reg, w, h, state);
  if (conflict) return { conflict };
  if (!facts.length) return { fact: null };
  const black = facts.find((f) => f.value === BLACK);
  return { fact: black || facts[0] };
}

/**
 * 推到不能再推。
 * 返回 { complete, contradiction, rounds, steps, state, log, byRule }
 *  - complete：全盘已定
 *  - rounds：轮询到不动点的轮数（链条有多长的读数）
 *  - steps：落定的事实总数
 */
export function solve(reg, w, h, opts = {}) {
  const n = w * h;
  const state = opts.state ? opts.state.slice() : initialState(n);
  const log = [];
  const byRule = {};
  let rounds = 0;
  let steps = 0;
  let contradiction = null;

  for (;;) {
    rounds += 1;
    const { facts, conflict } = deriveFacts(reg, w, h, state);
    if (conflict) { contradiction = conflict; break; }
    if (!facts.length) break;
    for (const f of facts) {
      if (state[f.cell] !== UNKNOWN) continue; // 同轮里可能多条指同一格，先到先得
      state[f.cell] = f.value;
      steps += 1;
      byRule[f.rule] = (byRule[f.rule] || 0) + 1;
      log.push({ ...f, round: rounds });
    }
    if (rounds > n * 4) { contradiction = { why: '推导不收敛（规则表有环？）' }; break; }
  }

  let unknown = 0;
  for (let i = 0; i < n; i += 1) if (state[i] === UNKNOWN) unknown += 1;
  return {
    complete: unknown === 0 && !contradiction,
    contradiction,
    rounds: rounds - 1, // 最后那轮什么都没推出来，不算一层链
    steps,
    unknown,
    byRule,
    state,
    log,
  };
}

// 校验一个 state 是否是题面下的合法解（黑格数、R1/R2 全查）。
export function stateToBlack(state) {
  const black = new Uint8Array(state.length);
  for (let i = 0; i < state.length; i += 1) if (state[i] === BLACK) black[i] = 1;
  return black;
}
