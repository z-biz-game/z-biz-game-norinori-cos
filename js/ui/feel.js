// 手感层（feel）：定步长仿真时钟 + 落子涟漪 + 提示脉冲。**不碰 DOM、不碰像素。**
//
// 为什么单独一个文件，而不是把 rAF 里的算术写进 main.js：
// 帧率无关这件事必须能被"同一份源码、同一颗种子、三种帧率"对拍。写在 main.js 里就得开浏览器
// 才能量，而浏览器一开，墙钟、合成器、后台节流全都进了读数。住在这里，node 直接 import 就能跑。
//
// 三条不变式（改这个文件就是改它们，别处不重复一遍）：
//  1) **定步长累加器**：`accum += 帧dt`，然后按 SIM_STEP 一步一步地跑仿真。渲染可以按帧插值，
//     仿真的步长恒定 ⇒ 任何逐粒子的位移行拿到的 dt 都等于 SIM_STEP，与显示器多少 Hz 无关。
//  2) 暂停期间**一个步都不走**（累加器清零 + 直接 return），恢复后不补跑：
//     补跑就等于把"玩家盯着暂停面板的那 30 秒"塞回粒子里。
//  3) 随机源是 js/engine/rng.js 的 mulberry32（同一个 seed 派生 'feel' 标签），
//     不用 Math.random：三种帧率对拍时"抖动不同"会被读成"状态不同"，那是假红。
//
// 阻尼写成 `Math.pow(k, dt*60)` 而不是 `*= 0.96`：后者的语义是"每帧乘一次"，
// 只在 60Hz 下等于设计值；定步长下两者数值相同，但只有前者在改了 SIM_STEP 之后仍然成立。

import { makeRng, derive } from '../engine/rng.js';

export const SIM_STEP = 1 / 60; // 秒；一步 16.666…ms
export const MAX_PARTICLES = 96;
const FLOATS = 7; // x, y, vx, vy, life, kind, cell
const PULSE_HZ = 1 / 1.2; // 与 theme.js 的 Board.hintPulseMs=1200 同一条数
const DAMP_PER_60 = 0.86; // 每 1/60 秒的速度阻尼
const LIFE_PER_60 = 0.94; // 每 1/60 秒的寿命衰减（乘性，所以余辉是渐近归零而不是硬切）
const REST_EPS = 0.002; // 速度落到这个量级就回收：定步长下这个阈值与帧率无关

export class Feel {
  constructor(seed = 1, { reducedMotion = false } = {}) {
    this.particles = new Float32Array(MAX_PARTICLES * FLOATS);
    this.reducedMotion = reducedMotion;
    this.reset(seed);
  }

  /** 换一局 / 重开：时钟、累加器、粒子、脉冲、随机源全部复位。 */
  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng = makeRng(derive(this.seed, 'feel'));
    this.simTime = 0;
    this.simSteps = 0;
    this.accum = 0;
    this.pulsePhase = 0;
    this.count = 0;
    this.spawned = 0;
    this.paused = false;
    this.particles.fill(0);
  }

  pause() {
    if (this.paused) return false;
    this.paused = true;
    // 归零而不是留着：暂停前那一刻的半帧余量如果带过去，恢复时就会先补跑一步。
    this.accum = 0;
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    this.accum = 0;
    return true;
  }

  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  setReducedMotion(on) {
    this.reducedMotion = !!on;
    if (this.reducedMotion) {
      this.count = 0; // 已经飞着的涟漪一并收掉：切换之后还继续动就是"设置没生效"
      this.pulsePhase = 0;
    }
  }

  /** 落子/擦子的涟漪：一律从格心**向外**、起始半径 0.30×格边。
   *
   * 为什么不从格心起步、也不做"朝心内收"的那种：浏览器闸在真点击之后会立刻取两个像素样本——
   * 这颗格的**中心**（判黑格/白点是不是那个颜色）与相邻两格的**共边中点**（判粗线）。
   * 粒子若盖在这两点上，accent 色会把取样拉出容差，判据就从"读代码"变成"看运气"。
   * 起始半径 0.30 格边 + 只朝外 ⇒ 中心永远干净；配合 board.js 把粒子裁在格内 70% 里，粗线也干净。
   * kind 只改速度与寿命档位，不改方向。 */
  spawn(cx, cy, size, index, kind = 0, n = 10) {
    if (this.reducedMotion) return 0; // reduceMotion 分支：粒子这一层整个不产生
    const boost = kind === 2 ? 0.55 : kind === 1 ? 0.8 : 1; // 撤销最弱、白点次之、黑格满档
    let made = 0;
    for (let k = 0; k < n; k += 1) {
      if (this.count >= MAX_PARTICLES) break;
      const i = this.count * FLOATS;
      const ang = this.rng() * Math.PI * 2;
      const speed = (26 + this.rng() * 54) * boost;
      const r0 = size * 0.3;
      this.particles[i] = cx + Math.cos(ang) * r0;
      this.particles[i + 1] = cy + Math.sin(ang) * r0;
      this.particles[i + 2] = Math.cos(ang) * speed;
      this.particles[i + 3] = Math.sin(ang) * speed;
      this.particles[i + 4] = 1;
      this.particles[i + 5] = kind;
      this.particles[i + 6] = index;
      this.count += 1;
      this.spawned += 1;
      made += 1;
    }
    return made;
  }

  /** 一帧进来：帧 dt 只喂累加器（这是全文件唯一吃"帧 dt"的一行），仿真按定步长走。 */
  advance(elapsedSec) {
    if (this.paused) return 0; // 暂停期间仿真不推进：一个步都不走
    this.accum += elapsedSec;
    let steps = 0;
    while (this.accum >= SIM_STEP) {
      this.step(SIM_STEP);
      this.accum -= SIM_STEP;
      steps += 1;
    }
    return steps;
  }

  step(dt) {
    this.simTime += dt;
    this.simSteps += 1;
    this.pulsePhase = (this.pulsePhase + dt * PULSE_HZ) % 1;
    const damp = Math.pow(DAMP_PER_60, dt * 60);
    const lifeK = Math.pow(LIFE_PER_60, dt * 60);
    let write = 0;
    for (let i = 0; i < this.count * FLOATS; i += FLOATS) {
      const p = this.particles;
      p[i] += p[i + 2] * dt;
      p[i + 1] += p[i + 3] * dt;
      p[i + 2] *= damp;
      p[i + 3] *= damp;
      p[i + 4] *= lifeK;
      const kind = p[i + 5];
      // 内收与回落的涟漪朝格心收：kind 1/2 把速度再压一份，视觉上就是"退回去"而不是"炸开"
      if (kind !== 0) p[i + 4] *= Math.pow(0.9, dt * 60);
      const alive = p[i + 4] > REST_EPS && (Math.abs(p[i + 2]) > 0.02 || Math.abs(p[i + 3]) > 0.02);
      if (!alive) continue;
      if (write !== i) {
        for (let f = 0; f < FLOATS; f += 1) p[write + f] = p[i + f];
      }
      write += FLOATS;
    }
    this.count = write / FLOATS;
  }

  /** 渲染用的插值位置：alpha ∈ [0,1) 是"这一步里已经走过的比例"，只影响画在哪、不影响状态。 */
  renderPos(alpha) {
    const out = [];
    const k = Math.max(0, Math.min(1, alpha));
    for (let i = 0; i < this.count * FLOATS; i += FLOATS) {
      const p = this.particles;
      out.push({
        x: p[i] + p[i + 2] * SIM_STEP * k,
        y: p[i + 1] + p[i + 3] * SIM_STEP * k,
        life: p[i + 4],
        kind: p[i + 5],
        cell: p[i + 6],
      });
    }
    return out;
  }

  /** 三档对拍要读的摘要：只有"会随虚拟时长变的量"，没有任何墙钟读数。 */
  digest() {
    return {
      simTime: this.simTime,
      simSteps: this.simSteps,
      pulsePhase: this.pulsePhase,
      particles: this.count,
      spawned: this.spawned,
      px: Array.from(this.particles.subarray(0, this.count * FLOATS)),
    };
  }
}
