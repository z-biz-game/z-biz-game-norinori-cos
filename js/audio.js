// 声音：三枚短促的"墨滴"，全部现算（没有音频资产 = 没有资产可裂）。
//
// 静音必须是**真静音**：AudioContext 挂起（suspend），并且静音态下不再新建任何振荡器节点。
// 只把 master gain 设 0 的那种"静音"在两件事上是假的：
//  1) 上下文还在跑，CPU 与功耗照旧；
//  2) 下一次落子仍然建了节点、排了日程，只是听不见——于是"我到底关没关"在代码里查不出来。
// 这里两条都堵上：`blip()` 在 muted 时直接 return false，一个节点都不建。
//
// 上下文**懒建**：Chrome 的自动播放策略要求先有用户手势，开机就 new AudioContext 只会得到
// 一个 "state: suspended" 的上下文和一条控制台警告。所以第一次真落子才建它。
//
// node 侧（无 AudioContext）不许炸：逻辑门与帧率对拍都在 node 里 import 这条路径上的模块，
// 拿 `typeof AudioContext` 判一下就行——这是边界，不是防御性写作。

const BLENDS = {
  black: { f0: 392, f1: 196, dur: 0.11, gain: 0.16, type: 'sine' },
  white: { f0: 784, f1: 660, dur: 0.07, gain: 0.1, type: 'triangle' },
  erase: { f0: 300, f1: 420, dur: 0.09, gain: 0.1, type: 'sine' },
  win: { f0: 523, f1: 1046, dur: 0.42, gain: 0.2, type: 'sine' },
  deny: { f0: 180, f1: 120, dur: 0.14, gain: 0.12, type: 'sawtooth' },
};

const Audio = {
  ctx: null,
  master: null,
  muted: false,
  nodes: 0, // 建过的振荡器节点数：闸与对拍都读它来判"静音态到底有没有建节点"
};

const Ctor = () => globalThis.AudioContext || globalThis.webkitAudioContext || null;

export function isMuted() {
  return Audio.muted;
}

export function stats() {
  return { muted: Audio.muted, nodes: Audio.nodes, ctxState: Audio.ctx ? Audio.ctx.state : 'none' };
}

/** 静音开关：挂起/恢复上下文，并返回新的静音态。没建过上下文时只翻标记——下次建的时候尊重它。 */
export function setMuted(on) {
  Audio.muted = !!on;
  const ctx = Audio.ctx;
  if (!ctx) return Audio.muted;
  // suspend/resume 在 Chrome 里是 Promise；这里不 await：静音是"立刻不再出声"，
  // 而 await 一个可能被自动播放策略挡住的 Promise 只会把异常留成未捕获。
  const op = Audio.muted ? ctx.suspend() : ctx.resume();
  if (op && op.catch) op.catch(() => {});
  return Audio.muted;
}

export function toggleMute() {
  return setMuted(!Audio.muted);
}

function ensure() {
  if (Audio.ctx) return Audio.ctx;
  const K = Ctor();
  if (!K) return null;
  try {
    Audio.ctx = new K();
    Audio.master = Audio.ctx.createGain();
    Audio.master.gain.value = 0.9;
    Audio.master.connect(Audio.ctx.destination);
  } catch {
    Audio.ctx = null; // 没有声卡/被策略禁掉的上下文：这是环境边界，不是我们的 bug
  }
  return Audio.ctx;
}

/** 响一声。静音态或没有 Web Audio 的场合返回 false，且**不建任何节点**。 */
export function blip(kind = 'black') {
  if (Audio.muted) return false;
  const spec = BLENDS[kind] || BLENDS.black;
  const ctx = ensure();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    const op = ctx.resume();
    if (op && op.catch) op.catch(() => {});
  }
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.f0, t);
  osc.frequency.exponentialRampToValueAtTime(spec.f1, t + spec.dur);
  gain.gain.setValueAtTime(spec.gain, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
  osc.connect(gain);
  gain.connect(Audio.master);
  osc.start(t);
  osc.stop(t + spec.dur + 0.02);
  Audio.nodes += 1;
  return true;
}
