'use strict';
// service worker 的接线：只做"能不能装"这一件事，不参与任何判定。
//
// 三条边界都是实测出来的，不是防御性写作：
//  1) file:// 下不注册。双击 index.html 打开（本仓没有构建，这条是真会发生的用法）时
//     origin 是 "null"，register() 会抛 SecurityError；这一句守卫让它**静默跳过**，
//     而不是在控制台留一条未捕获异常——本仓的浏览器闸把"启动期未捕获异常"算作红。
//  2) 说明符一律按 document.baseURI 解析。Pages 把站点发在 /<仓库名>/ 前缀下，
//     硬编 '/sw.js' 在这一形会 404，而"注册失败"是静默的：站点照样能玩，只是永远装不上。
//  3) scope 取目录而不是文件： './' 让 SW 管整个应用目录，管不到别人家去。
(function registerShell() {
  const proto = location.protocol;
  if (proto !== 'http:' && proto !== 'https:') return;
  if (!('serviceWorker' in navigator)) return;
  const swUrl = new URL('sw.js', document.baseURI).href;
  const scope = new URL('./', document.baseURI).href;
  // catch 而不是 let it throw：注册失败（CI 的沙箱、被策略拦掉的 SW）不该影响玩法。
  navigator.serviceWorker.register(swUrl, { scope }).catch(() => {});
})();
