// 主题与几何的唯一数字源。
//
// 为什么数字住在这里而不是 css/ 里：画布上的区域粗线、白点半径、选中环这些量必须与
// `js/render/board.js` 里 hitCell 用来算命中的那批数是**同一批**。分家就会出"盘画对了、
// 点击偏一格"的事故——所以 css 里一个几何数字都不许出现，它只消费 applyThemeVars 推下去的
// CSS 自定义属性（颜色/间距/字号），几何数字只在 canvas 那一侧用。
//
// 颜色在这里而不是 css 里还有一个原因：门禁要在**像素**上判"两种状态真的看得出来是两种"，
// 它读的是这张表，不是 computed style。

export const Palette = {
  pageBg: '#14161a',
  panelBg: '#1b1e24',
  ink: '#e8e6df',
  inkQuiet: '#9aa0ad',
  accent: '#f2c14e',
  boardBg: '#2a2f38',
  cellBg: '#e9e5da',
  cellBgAlt: '#ded8c9',
  black: '#191a1c',
  dot: '#8b6f3a',
  regionLine: '#20242b',
  gridLine: '#b9b2a2',
  selected: '#3d7bd6',
  hint: '#2fbf71',
  wrong: '#d4553f',
};

export const Space = { gap: 14, pad: 16, radius: 10, panelW: 320 };
export const Font = { ui: '15px/1.45 system-ui, -apple-system, "Noto Sans SC", sans-serif' };
export const Motion = { ms: 140 };

// Board：canvas 那一侧的全部数字。
export const Board = {
  cellMin: 30,
  cellMax: 78,
  pad: 14, // 画布内边距：粗线要完整落在画布内，不然 6x6 的最外圈边界会被裁掉半根
  gridWidth: 1, // 细线（同区域内相邻格）
  regionWidth: 0.16, // 粗线按格宽比例，保证 4x4 与 6x6 上视觉一致
  blackInset: 0.05, // 黑格填充留一点缝，让相邻两颗黑格仍然看得出来是"两个格"而不是一条
  dotRadius: 0.17, // 白点半径
  hintRing: 0.09,
  hintPulseMs: 1200,
};

const toVar = (name) => `--${name.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`;

export function applyThemeVars(root = document.documentElement) {
  for (const [k, v] of Object.entries(Palette)) root.style.setProperty(toVar(k), v);
  root.style.setProperty('--space-gap', `${Space.gap}px`);
  root.style.setProperty('--space-pad', `${Space.pad}px`);
  root.style.setProperty('--space-radius', `${Space.radius}px`);
  root.style.setProperty('--space-panel-w', `${Space.panelW}px`);
  root.style.setProperty('--motion-ms', `${Motion.ms}ms`);
  root.style.setProperty('--font-ui', Font.ui);
  return root;
}
