/**
 * 构建辅助脚本（无第三方依赖）：
 * 把 renderer 的静态资源（html 等）复制到 dist，与 tsc 编译产物配套。
 * 由 package.json 的 build 脚本在 tsc 之后调用。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const assets = [
  ['src/renderer/index.html', 'dist/renderer/index.html'],
];

for (const [from, to] of assets) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

console.log('[copy-assets] done');
