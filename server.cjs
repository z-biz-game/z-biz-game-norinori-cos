#!/usr/bin/env node
// 浏览器闸用的静态服务器：把某个目录挂到 http://127.0.0.1:<port>/，仅此而已。
// 写成 CommonJS 是有原因的：package.json 是 "type":"module"，js/ 下那些文件要被 node --check 当
// ES 模块解析，而这一份要能被 tools/playtest.cjs 那边直接 require，不必再来一次 ESM/CJS 互操作。
//
// 它故意**不**参与判定：没有构建、没有 API、没有一个字节是服务器算出来的。
// 出现任何一种"服务器帮页面补一下"的逻辑，浏览器闸测的就不是部署站点上那份代码了。
//
// 两种 URL 形态，因为 GitHub Pages 把本仓发在一个路径段下：
//   root    http://127.0.0.1:5279/                        （不带 PREFIX：仓库自己就是文档根）
//   prefix  http://127.0.0.1:5280/z-biz-game-norinori-cos/（PREFIX=/z-biz-game-norinori-cos）
// 前缀那一形是唯一能抓住"页内写了以 / 开头的说明符"的形态，所以它是这里的一个**真模式**，
// 不是脚注：本地服务器在 root 形下能蒙对，线上却 404。
// 前缀模式下裸 `/` 故意回一个点名要求的 404（不重定向）——会答 `/` 的前缀服务器等于让接错形态的
// 闸腿照样能过，而那正是这第二个模式存在的唯一理由。`/<仓名>`（少一个尾斜杠）才 301 到 `/<仓名>/`。
const { createServer } = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const { join, normalize, resolve, sep, extname } = require('node:path');

const argOf = (name, dflt) => {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split('=')[1] : dflt;
};

const ROOT = resolve(argOf('root', __dirname));
const PORT = Number(argOf('port', process.env.PORT || 5279));
const HOST = argOf('host', '127.0.0.1');
// '/z-biz-game-norinori-cos' / 'z-biz-game-norinori-cos/' / 'z-biz-game-norinori-cos' → 同一段。
const PREFIX = String(process.env.PREFIX || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// 只服务 ROOT 里面的文件：`..` 与绝对路径都要在这一层挡掉，而不是"试试看会不会炸"。
const inRoot = (p) => {
  const r = resolve(p);
  return r === ROOT || r.startsWith(ROOT + sep);
};

async function lookup(pathname) {
  let p = pathname;
  if (PREFIX) {
    const seg = `/${PREFIX}`;
    if (p === seg) return { code: 301, headers: { Location: `${seg}/` } };
    if (!p.startsWith(`${seg}/`)) {
      return { code: 404, body: `404 — 这一台服务器只在 /${PREFIX}/ 下发货（Pages 的形状）。裸 / 不重定向，为的就是接错形态的闸腿不能蒙过去。` };
    }
    p = p.slice(seg.length);
  }
  const rel = normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
  let file = join(ROOT, rel);
  if (!inRoot(file)) return { code: 403, body: 'forbidden' };
  try {
    const st = await stat(file);
    if (st.isDirectory()) {
      file = join(file, 'index.html');
      if (!inRoot(file)) return { code: 403, body: 'forbidden' };
      await stat(file);
    }
  } catch {
    return { code: 404, body: 'not found' };
  }
  try {
    const buf = await readFile(file);
    return { code: 200, body: buf, type: TYPES[extname(file).toLowerCase()] || 'application/octet-stream' };
  } catch {
    return { code: 404, body: 'not found' };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  let out;
  try {
    out = await lookup(url.pathname);
  } catch (err) {
    out = { code: 500, body: String((err && err.message) || err) };
  }
  res.writeHead(out.code, {
    // no-store：闸会重载页面，任何一层缓存都可能让它读到上一轮的代码。
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': out.type || 'text/plain; charset=utf-8',
    ...out.headers || {},
  });
  res.end(out.body);
});

server.listen(PORT, HOST, () => {
  console.log(`serve ${ROOT} http://${HOST}:${PORT}/  ${PREFIX ? `PREFIX=/${PREFIX}` : 'root shape'}  pid=${process.pid}`);
});
