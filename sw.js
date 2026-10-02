'use strict';
// 离线壳：network-first，**绝不 cache-first**。
//
// 为什么这条是死的：本仓没有构建步骤，js/ 下十几个 ES 模块与 css 就是线上跑的字节。
// cache-first 配一个手工 VERSION 号，等于"改了代码忘了 bump 就把旧版永久钉死"——
// 出新 HTML 配旧 JS 的鬼状态在同组织已经红过一次（页面看着是新的，判定是上个月的）。
// network-first 的代价是每次要多一个往返，收益是：**没有**这种鬼状态。
//
// 版本号仍然留着（CACHE 名带 v），但它只用于"整套换血时把上一代缓存清掉"，
// 不是"这一版内容就这样了"的承诺：内容以网络为准。
//
// 只接管同源 GET：跨源的东西（没有，但将来会有）一律放行不管，
// 把别人的响应塞进自己的缓存等于替别人做可用性决定。
const VERSION = 'norinori-v1';
const FALLBACK = './';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const sameOriginGet = (req) => req.method === 'GET' && new URL(req.url).origin === self.location.origin;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (!sameOriginGet(req)) return;
  const isNav = req.mode === 'navigate';
  e.respondWith(
    fetch(req, { cache: 'no-store' })
      .then((res) => {
        // 命中网络就顺手回填：只存 200，把 404/500 存下来等于把一次故障变成离线期的默认答案。
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: !isNav })
        .then((hit) => hit || (isNav ? caches.match(FALLBACK) : Response.error()))),
  );
});
