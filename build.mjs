/**
 * Build: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js  — host entry, loaded by the dsh Node process (ESM, bundled)
 *  - lib/client.js — browser bundle in ModuleLoader.load format (CJS, react external)
 *
 * Everything is bundled so the plugin is self-contained at runtime. The
 * @deepseek-ai/* packages are resolved at BUILD time through node_modules
 * junction mirrors created by scripts/link-dsh.ps1 (we don't have a pnpm
 * workspace like the reference implementation — our source is the dsh install).
 */
import { build, context } from 'esbuild';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))];

// 客户端 bundle 的 loader id 必须与包名一致（ModuleLoader 用它做注册键）
const CLIENT_ID = 'dsh-mem';

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
};

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  // react 走 shell 单例（ModuleLoader 的 require 解析到 seed 里的 react）。
  // 打进 bundle 会造成双 React 实例，slots 渲染直接崩。
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      `  id: ${JSON.stringify(CLIENT_ID)},`,
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
};

if (!existsSync(new URL('./node_modules/@deepseek-ai', import.meta.url))) {
  console.error('[build] 缺少 node_modules/@deepseek-ai 镜像。先跑： npm run link');
  process.exit(1);
}

// 守卫：cordis.patch.yml 是 YAML，只支持 `#` 注释。
// 曾把 /** ... */ 写进去，导致 `dsh --dump-config` 报
// "end of the stream or a document separator is expected" —— 插件完全挂不上。
// 这种错误只在装配期暴露，构建期拦下来成本最低。
{
  const patch = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8');
  const bad = patch
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /^\s*(\/\*|\/\/)/.test(line));
  if (bad.length) {
    console.error('[build] cordis.patch.yml 含非 YAML 注释（只支持 #）：\n' +
      bad.map((b) => `  第 ${b.n} 行: ${b.line.trim()}`).join('\n'));
    process.exit(1);
  }
}

if (watch) {
  await (await context(hostOptions)).watch();
  await (await context(clientOptions)).watch();
  console.log('[build] watching src/ for changes...');
} else {
  // 记忆空间的默认模板随包发布（lib/templates/），运行时读取，不参与 bundle。
  cpSync(new URL('./src/templates', import.meta.url), new URL('./lib/templates', import.meta.url), {
    recursive: true,
  });
  await Promise.all([build(hostOptions), build(clientOptions)]);
}
