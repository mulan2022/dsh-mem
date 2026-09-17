/**
 * Build: TS source -> deployable package.
 *
 * Two artifacts:
 *  - lib/index.js  — host entry, loaded by the dsh Node process (ESM, bundled)
 *  - lib/client.js — browser bundle in ModuleLoader.load format (CJS, react external)
 *
 * Everything is bundled so the plugin is self-contained at runtime.
 *
 * `@deepseek-ai/*` 只在**构建期**需要（打包解析）。解析顺序：
 *   1. 本地 `node_modules/`（`npm install` 装的，或 `npm run link` 建的 junction 镜像）；
 *   2. 回退到 **DSH 自己的安装位置**里的那份 —— 本插件只有装了 dsh 才有意义，
 *      那里必然有一份。这一条让 git 安装时的 `prepare` 在任意平台上都能构建，
 *      不再依赖 PowerShell、也不再要求 Windows。
 */
import { build, context } from 'esbuild';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

/** 本地 node_modules：`npm install` 与 `npm run link` 都往这里放 `@deepseek-ai/*`。 */
const localModules = fileURLToPath(new URL('./node_modules', import.meta.url));

/**
 * 给出 esbuild 的解析路径。
 *
 * 本地镜像存在就只用本地；否则回退到 DSH 安装位置里的那一份。
 * 两处都找不到**直接报错退出** —— 静默降级只会把问题推到运行期才暴露。
 */
function resolveNodePaths() {
  const paths = [localModules];
  if (existsSync(join(localModules, '@deepseek-ai'))) return paths;

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const candidates = [
    join(dshHome, 'profiles', 'node_modules'),
    join(dshHome, 'profiles', 'web', 'node_modules'),
  ];
  const found = candidates.filter((p) => existsSync(join(p, '@deepseek-ai')));
  if (found.length === 0) {
    console.error(
      '[build] 找不到 @deepseek-ai/*（构建期解析用）。\n' +
        '  本插件依赖已安装的 DSH —— 请在装了 dsh 的环境里构建，\n' +
        '  或用 DSH_HOME 环境变量指定 dsh home 的位置。\n' +
        `  已找过：${candidates.join('、')}`,
    );
    process.exit(1);
  }
  return [...paths, ...found];
}

const nodePaths = resolveNodePaths();

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
