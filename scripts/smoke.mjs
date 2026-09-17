/**
 * 冒烟测试：不启动 dsh，直接用桩 ctx 跑构建产物 lib/index.js。
 *
 * 验证 P1 的三件事：
 *  1. vault 目录约定被建立（chat / project._shared / 项目分区）
 *  2. 由 sections.yaml 推导出的分区文件被写出来
 *  3. 派生索引能从 vault 文件重建
 *
 * 用临时 DSH_HOME，绝不碰用户真实数据。
 */
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-mem-smoke-'));
process.env.DSH_HOME = HOME;

let failures = 0;
function check(label, cond, detail = '') {
  const mark = cond ? '✅' : '❌';
  if (!cond) failures++;
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ''}`);
}

console.log(`临时 DSH_HOME: ${HOME}\n`);

const mod = await import('../lib/index.js');

// ---- 桩 ctx ----
const logs = [];
const effects = [];
/** apply 期间注册进来的工具（宿主工具注册表的桩）。 */
const registeredTools = new Map();
/** apply 期间注册的 system prompt section。 */
const registeredSections = [];
/** apply 期间注册的事件监听器。 */
const listeners = {};
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m), error: (m) => logs.push('ERR ' + m) },
  tools: {
    register(t) {
      registeredTools.set(t.name, t);
      return () => registeredTools.delete(t.name);
    },
  },
  systemPrompt: {
    section(s) {
      registeredSections.push(s);
      return () => {};
    },
  },
  on(event, handler) {
    (listeners[event] ??= []).push(handler);
    return () => {};
  },
  effect(fn) {
    effects.push(fn());
  },
};

await mod.apply(ctx, { enabled: true, home: HOME, projectRootMarkers: ['.git'], promptLang: 'zh' });

console.log('=== 1. 日志 ===');
for (const l of logs) console.log('   ' + l);

console.log('\n=== 2. 目录约定 ===');
const chatDir = join(HOME, '.dsh-mem', 'spaces', 'chat');
const globalDir = join(HOME, '.dsh-mem', 'shared');
for (const [label, dir] of [['全局层(shared)', globalDir], ['聊天记忆(chat)', chatDir]]) {
  check(`${label} 存在`, existsSync(dir), dir);
  for (const sub of ['sections', 'entities', 'raw', 'raw/timeline']) {
    check(`${label}/${sub}`, existsSync(join(dir, sub)));
  }
}
// 跨项目层已并入全局层 —— 这个目录不该再被创建
check('旧的跨项目层不再创建', !existsSync(join(HOME, '.dsh-mem', 'spaces', 'project', '_shared')));
// 并入的那几条 section 现在长在全局层里
for (const f of ['ability.md', 'preferences.md', 'stack.md']) {
  check(`全局层已含 ${f}`, existsSync(join(globalDir, 'sections', f)));
}

console.log('\n=== 3. 文件 ===');
const chatFiles = readdirSync(chatDir).sort();
console.log('   chat 顶层: ' + chatFiles.join(', '));
for (const f of ['README.md', 'sections.yaml', 'observations.md', 'log.md']) {
  check(`chat/${f} 已生成`, chatFiles.includes(f));
}
const chatSections = readdirSync(join(chatDir, 'sections')).sort();
console.log('   chat/sections: ' + chatSections.join(', '));
check('chat 分区文件数量 > 0', chatSections.length > 0, `${chatSections.length} 个`);

console.log('\n=== 4. 派生索引 ===');
const dbPath = join(HOME, '.dsh-mem', 'index.db');
check('index.db 已建立', existsSync(dbPath));

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT space, project, kind, name FROM idx_entries ORDER BY space, kind, name').all();
console.log(`   索引条目 ${rows.length} 条：`);
for (const r of rows.slice(0, 14)) {
  console.log(`     ${String(r.space).padEnd(8)} ${String(r.project ?? '-').padEnd(8)} ${String(r.kind).padEnd(8)} ${r.name}`);
}
if (rows.length > 14) console.log(`     … 另有 ${rows.length - 14} 条`);
check('索引非空', rows.length > 0);
check('含有 section 类条目', rows.some((r) => r.kind === 'section'));
check('含有 observ 条目', rows.some((r) => r.kind === 'observ'));
db.close();

console.log('\n=== 5. 项目分区（按需创建）===');
const part = mod.ensureProjectPartition(HOME, 'D:\\demo\\MemoryChat', ['.git']);
console.log(`   key=${part.key}  root=${part.root}`);
check('key 形如 D--demo-MemoryChat', part.key === 'D--demo-MemoryChat', part.key);
check('分区目录已建立', existsSync(part.dir));
const partFiles = readdirSync(part.dir).sort();
console.log('   分区顶层: ' + partFiles.join(', '));
check('分区含 timeline.md', partFiles.includes('timeline.md'));
check('分区含 sections.yaml', partFiles.includes('sections.yaml'));

console.log('\n=== 6. 幂等性（重复 apply 不覆盖用户内容）===');
const probe = join(chatDir, 'README.md');
const { writeFileSync, readFileSync } = await import('node:fs');
writeFileSync(probe, '# 用户手改过的内容\n', 'utf8');
mod.ensureSpaceVault(chatDir, 'chat');
check('用户内容未被覆盖', readFileSync(probe, 'utf8').includes('用户手改过的内容'));

console.log('\n=== 7. 路径安全（拒绝逃逸）===');
const vaultMod = await import('../src/vault.ts').catch(() => null);
if (vaultMod) {
  check('拒绝 ../ 逃逸读', vaultMod.readVaultFile(chatDir, '../../index.db') === null);
  check('拒绝 ../ 逃逸写', vaultMod.writeVaultFile(chatDir, '../evil.md', 'x') === false);
} else {
  console.log('   （跳过：直接跑 TS 需 tsx，改由类型层保证）');
}

console.log('\n=== 8. 宿主数据面路由（桩 webServer）===');
const registered = [];
const routeCtx = {
  logger: { info: () => {}, warn: () => {} },
  get: (n) => (n === 'webServer' ? { register: (r) => { registered.push(r); return () => {}; } } : undefined),
};
const { registerVaultRoutes, resolveSpaceDir } = mod;
const disposeRoutes = registerVaultRoutes(routeCtx, mod.createVaultApi(
  { enabled: true, home: HOME, projectRootMarkers: ['.git'], promptLang: 'zh' },
  () => null,
));
await new Promise((r) => setTimeout(r, 50)); // registerVaultRoutes 是同步尝试 + 可能重试

check('注册了 6 条路由', registered.length === 6, registered.map((r) => r.path).join(', '));
check('路由前缀为 /dsh-mem', registered.every((r) => r.path.startsWith('/dsh-mem/')));

/** 触发一次 handler 并收集响应。 */
function call(path, query = '', method = 'GET') {
  return new Promise((resolve) => {
    const route = registered.find((r) => r.path === path);
    if (!route) return resolve({ status: 0, body: null });
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null, headers: this.headers }); },
    };
    route.handler({ method, url: path + query }, res);
  });
}

const ov = await call('/dsh-mem/overview');
check('overview → 200', ov.status === 200, `status=${ov.status}`);
check('overview 含 memRoot', typeof ov.body?.memRoot === 'string');
check('overview 含 chatShared', ov.body?.chat?.dir?.includes('chat'), ov.body?.chat?.dir);

const tr = await call('/dsh-mem/tree', '?space=chat');
check('tree?space=chat → 200', tr.status === 200);
check('tree 返回数组', Array.isArray(tr.body?.tree));
check('tree 含 sections 目录', tr.body?.tree?.some((n) => n.name === 'sections'));
check('tree 响应 no-store', tr.headers?.['cache-control'] === 'no-store');

const fl = await call('/dsh-mem/file', '?space=chat&rel=README.md');
check('file?space=chat&rel=README.md → 200', fl.status === 200);
check('file 正文非空', typeof fl.body?.text === 'string' && fl.body.text.length > 10);

check('未知 space → 404', (await call('/dsh-mem/tree', '?space=nope')).status === 404);

console.log('\n=== 8b. 空间解析的路径安全 ===');
check('拒绝 project:../ 逃逸', resolveSpaceDir(mod.createVaultApi(
  { enabled: true, home: HOME, projectRootMarkers: ['.git'], promptLang: 'zh' }, () => null), 'project:../../etc') === null);
check('未知空间返回 null', resolveSpaceDir(mod.createVaultApi(
  { enabled: true, home: HOME, projectRootMarkers: ['.git'], promptLang: 'zh' }, () => null), 'bogus') === null);

console.log('\n=== 8c. 常驻记忆（A 层）：只读接口 + 工具写入 ===');

/** 带 body 的 POST —— 用来验证「HTTP 打不动它」。 */
function post(path, payload) {
  return new Promise((resolve) => {
    const route = registered.find((r) => r.path === path);
    if (!route) return resolve({ status: 0, body: null });
    const listeners = {};
    const req = {
      method: 'POST',
      url: path,
      on(ev, cb) {
        (listeners[ev] ??= []).push(cb);
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { resolve({ status: this.statusCode, body: b ? JSON.parse(b) : null, headers: this.headers }); },
    };
    route.handler(req, res);
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    for (const cb of listeners['data'] ?? []) cb(buf);
    for (const cb of listeners['end'] ?? []) cb();
  });
}

const INS = '/dsh-mem/instructions';
const insPath = join(HOME, '.dsh-mem', 'shared', 'instructions.md');

const { readFileSync: _rf } = await import('node:fs');

// ---- 读接口 ----
const ins0 = await call(INS);
check('GET instructions → 200', ins0.status === 200, `status=${ins0.status}`);
check('初始为空列表', Array.isArray(ins0.body?.items) && ins0.body.items.length === 0);
check('上限为 50', ins0.body?.max === 50, String(ins0.body?.max));

// ---- 结构性约束：没有写接口，HTTP 打不动它 ----
const fileBefore = _rf(insPath, 'utf8');
await post(INS, { action: 'add', text: '通过 HTTP 偷加的' });
check('POST 无法改变常驻记忆（无写接口）', _rf(insPath, 'utf8') === fileBefore);
check('POST 后条目数仍为 0', (await call(INS)).body?.items?.length === 0);

// ---- 工具是唯一写入路径 ----
const memTools = new Map();
mod.registerMemTools((t) => memTools.set(t.name, t), { sharedDir: join(HOME, '.dsh-mem', 'shared') });
check('注册了 mem_remember', memTools.has('mem_remember'));
check('注册了 mem_forget', memTools.has('mem_forget'));
check('工具名不与 meow-memory 的 memory_* 冲突', !memTools.has('memory_remember'));

const remember = (text) => memTools.get('mem_remember').execute({ text }, {});
const forget = (text) => memTools.get('mem_forget').execute({ text }, {});

const a1 = await remember('回答时不要用 emoji');
check('mem_remember → ok', a1.ok === true);
check('计数为 1', a1.count === 1, String(a1.count));

const readBack = await call(INS);
check('HTTP 能读回工具写进去的条目', readBack.body?.items?.[0]?.text === '回答时不要用 emoji');
check('落盘到 shared/instructions.md', _rf(insPath, 'utf8').includes('- 回答时不要用 emoji'));

const aDup = await remember('回答时不要用 emoji');
check('重复 → ok:false', aDup.ok === false);
check('重复原因说明已在库中', String(aDup.reason).includes('已经在'), String(aDup.reason));

const aEmpty = await remember('   ');
check('空内容 → ok:false', aEmpty.ok === false, String(aEmpty.reason));

const aNl = await remember('第一行\n第二行');
check('换行被规范成单行', aNl.ok === true && (await call(INS)).body.items.some((i) => i.text === '第一行 第二行'));

const f1 = await forget('第一行 第二行');
check('mem_forget → ok', f1.ok === true);
check('删除后剩 1 条', f1.count === 1, String(f1.count));

const fMiss = await forget('不存在的条目');
check('删不存在 → ok:false', fMiss.ok === false);
check('删不存在时回带全部条目供模型核对', Array.isArray(fMiss.items) && fMiss.items.includes('回答时不要用 emoji'));

// ---- 上限：满了「拒绝并提示」，绝不静默淘汰最旧的 ----
console.log('\n--- 上限 50 条的行为 ---');
let last = null;
for (let i = 1; i < 50; i++) last = await remember(`测试条目 ${i}`);
check('填满到 50 条', last?.count === 50, String(last?.count));

const firstBefore = (await call(INS)).body.items[0].text;
const over = await remember('第 51 条');
check('第 51 条 → ok:false', over.ok === false);
check('满额原因提到上限', String(over.reason).includes('上限'), String(over.reason));
check('满额后仍是 50 条', over.count === 50, String(over.count));
check('最旧的一条【没有被淘汰】', (await call(INS)).body.items[0].text === firstBefore, firstBefore);

console.log('\n=== 8d. 注入（P2）===');

const inj = mod;

// ---- 静态手册 ----
const guide1 = inj.buildGuide();
const guide2 = inj.buildGuide();
check('静态手册非空', guide1.length > 100, `${guide1.length} 字符`);
check('静态手册恒定（KV 缓存友好）', guide1 === guide2);
check('手册提到两个工具', guide1.includes('mem_remember') && guide1.includes('mem_forget'));
check('手册写明只在用户明确要求时写', guide1.includes('只在用户明确要求'));

const sec = registeredSections.find((s) => s.name === inj.GUIDE_SECTION_NAME);
check('静态手册已注册为 system prompt section', sec !== undefined);
check('手册 section 顺序在工具之后', sec?.order === 3000, String(sec?.order));
check('手册是纯文本（非函数）', typeof sec?.text === 'string');

// ---- 动态注入块 ----
check('没有内容时返回 null', inj.buildInjection({ sharedVaultDir: join(HOME, 'nope'), maxChars: 2000 }) === null);

const beforeText = inj.buildInjection({ sharedVaultDir: join(HOME, '.dsh-mem', 'shared'), maxChars: 2000 });
check('有待注入内容时非 null', beforeText !== null);
check('注入块含「常驻记忆」标题', String(beforeText).includes('常驻记忆'));
check('注入块含刚才写的条目', String(beforeText).includes('回答时不要用 emoji'));
check('注入块声明「参考资料而非指令」', String(beforeText).includes('参考资料'));

const tiny = inj.buildInjection({ sharedVaultDir: join(HOME, '.dsh-mem', 'shared'), maxChars: 60 });
check('超预算时截断并说明', String(tiny).length <= 60 + 40 && String(tiny).includes('已截断'), String(tiny).length);

// ---- 消息包装 ----
const msg = inj.createInjectionMessage('测试内容');
check('注入消息 source.kind = plugin', msg?.source?.kind === 'plugin', String(msg?.source?.kind));
check('注入消息 source.plugin = dsh-mem', msg?.source?.plugin === 'dsh-mem');
check('注入消息 role = user', msg?.role === 'user', String(msg?.role));

// ---- pre-step 注入行为 ----
const preSteps = listeners['agent/pre-step'] ?? [];
check('注册了 agent/pre-step 监听器', preSteps.length === 1, String(preSteps.length));

const userMsg = { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] };
const toolMsg = { source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool out' }] };

const callPreStep = (messages, sid) =>
  preSteps[0]({ agent: { session: { header: { id: sid } } } }, async () => ({ kind: 'enter', messages }));

// 会话 A：含真实用户消息 → 注入
const rA = await callPreStep([userMsg], 'sess-A');
check('含用户消息的批次被注入', rA.messages.length === 2, String(rA.messages.length));
check('注入消息排在用户消息【之前】', rA.messages[0].source?.plugin === 'dsh-mem', JSON.stringify(rA.messages.map((m) => m.source?.kind)));
check('用户消息仍在最后', rA.messages[1] === userMsg);
check('注入正文含常驻记忆', JSON.stringify(rA.messages[0].content).includes('回答时不要用 emoji'));

// 会话 A 第二次 → 不重复注入（否则随轮次线性膨胀 token）
const rA2 = await callPreStep([userMsg], 'sess-A');
check('同一会话不重复注入', rA2.messages.length === 1, String(rA2.messages.length));

// 只有工具消息的批次 → 不注入（工具轮/子步骤不该被污染）
const rB = await callPreStep([toolMsg], 'sess-B');
check('不含真实用户消息的批次不注入', rB.messages.length === 1, String(rB.messages.length));

// 新会话 → 注入
const rC = await callPreStep([userMsg], 'sess-C');
check('新会话会注入', rC.messages.length === 2, String(rC.messages.length));

// 决策不是 enter → 原样返回
const rejected = await preSteps[0](
  { agent: { session: { header: { id: 'sess-D' } } } },
  async () => ({ kind: 'reject' }),
);
check('kind != enter 时原样返回', rejected.kind === 'reject');

// ---- 压缩后重新注入 ----
const sessionEvents = listeners['session/event'] ?? [];
check('注册了 session/event 监听器', sessionEvents.length === 1, String(sessionEvents.length));

const rC2 = await callPreStep([userMsg], 'sess-C');
check('压缩前仍不重复注入', rC2.messages.length === 1, String(rC2.messages.length));

sessionEvents[0]({ header: { id: 'sess-C' } }, { type: 'compaction/end' });
const rC3 = await callPreStep([userMsg], 'sess-C');
check('压缩后会重新注入（记忆不会因压缩消失）', rC3.messages.length === 2, String(rC3.messages.length));

console.log('\n=== 8e. 实体名精确命中 + 顺链一跳（P3）===');

const entDir = join(HOME, '.dsh-mem', 'shared', 'entities');
const { mkdirSync: _mkdir, writeFileSync: _wf } = await import('node:fs');
_mkdir(entDir, { recursive: true });

const entityPage = (name, body, attrs = '') =>
  `---\nname: ${name}\n${attrs}---\n\n${body}\n`;

_wf(join(entDir, '攀岩项目.md'), entityPage('攀岩项目', '用户在做攀岩相关的小程序。[[高斯泼溅]]', 'kind: project\nstatus: ongoing\n'), 'utf8');
_wf(join(entDir, '高斯泼溅.md'), entityPage('高斯泼溅', '一种 3D 重建技术，攀岩项目里用它做地形。', 'kind: concept\nstatus: active\n'), 'utf8');
_wf(join(entDir, '意识之镜.md'), entityPage('意识之镜', '用户写的 AI 意识主题哲学文章。', 'kind: concept\nstatus: stuck\naliases: 意识镜, 镜子\n'), 'utf8');
_wf(join(entDir, '孤立页.md'), entityPage('孤立页', '没有任何链接指向它，也没指向别人。'), 'utf8');

// ---- 扫描与解析 ----
const all = inj.scanEntities(join(HOME, '.dsh-mem', 'shared'));
check('扫到 4 个实体', all.length === 4, String(all.length));
const rock = all.find((e) => e.name === '攀岩项目');
check('解析出 front-matter kind', rock?.kind === 'project', String(rock?.kind));
check('解析出 front-matter status', rock?.status === 'ongoing', String(rock?.status));
check('解析出 [[双链]]', rock?.links?.includes('高斯泼溅'), JSON.stringify(rock?.links));
const mirror = all.find((e) => e.name === '意识之镜');
check('解析出别名', mirror?.aliases?.includes('镜子'), JSON.stringify(mirror?.aliases));

// ---- 匹配 ----
const byName = (t) => inj.matchEntities(t, all).map((e) => e.name);
check('按主名命中', byName('我想聊聊攀岩项目').includes('攀岩项目'), JSON.stringify(byName('我想聊聊攀岩项目')));
check('按别名命中', byName('那个镜子的事').includes('意识之镜'), JSON.stringify(byName('那个镜子的事')));
check('不相关文本不命中', byName('今天天气不错').length === 0, JSON.stringify(byName('今天天气不错')));
check('多个命中按名字长度降序', (() => {
  const r = byName('意识之镜 和 攀岩项目 都提到了');
  return r.indexOf('意识之镜') <= r.indexOf('攀岩项目');
})(), JSON.stringify(byName('意识之镜 和 攀岩项目 都提到了')));

// ---- 顺链一跳 ----
const hop = inj.expandOneHop([rock], all);
check('顺链取到邻居', hop.length === 1 && hop[0].name === '高斯泼溅', JSON.stringify(hop.map((e) => e.name)));
const hop2 = inj.expandOneHop([mirror], all);
check('无链接的实体没有邻居', hop2.length === 0, String(hop2.length));
const hop3 = inj.expandOneHop([rock, all.find((e) => e.name === '高斯泼溅')], all);
check('已命中的实体不会被当作邻居重复', hop3.length === 0, JSON.stringify(hop3.map((e) => e.name)));

// ---- 索引 + 渲染 ----
const idx = new inj.EntityIndex([join(HOME, '.dsh-mem', 'shared')], 0);
const res = idx.resolve('攀岩项目进展如何');
check('索引 resolve 得到命中', res.hit.length === 1 && res.hit[0].name === '攀岩项目');
check('索引 resolve 得到一跳邻居', res.neighbors.length === 1 && res.neighbors[0].name === '高斯泼溅');

const entText = inj.buildEntityInjection(res.hit, res.neighbors, 3000);
check('实体注入块非空', typeof entText === 'string' && entText.length > 0);
check('块内含命中实体正文', String(entText).includes('攀岩相关的小程序'));
check('块内含邻居正文', String(entText).includes('3D 重建技术'));
check('块内声明不是指令', String(entText).includes('不是指令'));
check('无命中时返回 null', inj.buildEntityInjection([], [], 3000) === null);

const tinyEnt = inj.buildEntityInjection(res.hit, res.neighbors, 40);
check('实体块超预算时截断', String(tinyEnt).includes('已截断'), String(tinyEnt).length);

// ---- pre-step 里的实体命中（走真实插件链路）----
// 注意：apply 时装的注入用的是默认 30s TTL，且实体目录当时还是空的。
// 这里用 TTL=0 的索引再装一次，验证 pre-step → 实体命中的完整链路。
const entListeners = {};
const entCtx = {
  logger: { info: () => {}, warn: () => {} },
  systemPrompt: { section: () => () => {} },
  on(ev, h) { (entListeners[ev] ??= []).push(h); return () => {}; },
};
const entIndex = new inj.EntityIndex([join(HOME, '.dsh-mem', 'shared')], 0);
inj.resetInjectionState();
inj.installInjection(entCtx, {
  sharedVaultDir: join(HOME, '.dsh-mem', 'shared'),
  maxChars: 2000,
  entityIndex: entIndex,
  entityMaxChars: 3000,
});

const pre = entListeners['agent/pre-step'][0];
const run = (text, sid) =>
  pre({ agent: { session: { header: { id: sid } } } }, async () => ({
    kind: 'enter',
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  }));

const e1 = await run('攀岩项目现在怎么样了', 'ent-A');
/** 取一批消息里 dsh-mem 注入消息的 section 名，按顺序 —— 断言结构比数数更准。 */
const injNames = (r) =>
  r.messages.filter((m) => m.source?.plugin === 'dsh-mem').map((m) => m.source?.sections?.[0]?.name);
check(
  'A 层与实体各是一条独立注入消息',
  JSON.stringify(injNames(e1)) === JSON.stringify(['记忆空间', '实体记忆']),
  JSON.stringify(injNames(e1)),
);
check('两条注入都在用户消息之前', e1.messages[e1.messages.length - 1].source?.kind === 'user');
const entMsg = e1.messages.find((m) => m.source?.sections?.[0]?.name === '实体记忆');
check('实体消息内含邻居正文（顺链一跳生效）', JSON.stringify(entMsg?.content).includes('3D 重建技术'));

const e2 = await run('再说说攀岩项目', 'ent-A');
check('同一实体不重复注入', e2.messages.length === 1, String(e2.messages.length));

const e3 = await run('换个话题，意识之镜呢', 'ent-A');
check('新实体仍会注入', e3.messages.length === 2, String(e3.messages.length));

const e4 = await run('完全无关的一句话', 'ent-B');
check('无实体命中时新会话只注 A 层', e4.messages.length === 2, String(e4.messages.length));

// 压缩后实体也允许重注
const entSessionEvents = entListeners['session/event'][0];
entSessionEvents({ header: { id: 'ent-A' } }, { type: 'compaction/end' });
const e5 = await run('再说说攀岩项目', 'ent-A');
check(
  '压缩后 A 层与实体都重新注入',
  JSON.stringify(injNames(e5)) === JSON.stringify(['记忆空间', '实体记忆']),
  JSON.stringify(injNames(e5)),
);

console.log('\n=== 8f. 实体目录（开局给标题）+ mem_entity 工具（按需翻页）===');

const sharedVault = join(HOME, '.dsh-mem', 'shared');
const allEnt = inj.scanEntities(sharedVault);

// ---- 目录：只列名字，不含正文 ----
const cat = inj.renderCatalog(allEnt);
check('目录非空', typeof cat === 'string' && cat.length > 0);
check('目录含实体名', String(cat).includes('攀岩项目'));
check('目录含 kind/status', String(cat).includes('ongoing') && String(cat).includes('project'));
check('目录【不含正文】', !String(cat).includes('攀岩相关的小程序'));

const cat2 = inj.renderCatalog(allEnt, 2);
check('目录受条数上限约束', String(cat2).split('\n').filter((l) => l.startsWith('- ')).length === 2);
check('超限时报出剩余数量', String(cat2).includes('另有 2 个未列出'), String(cat2));
check('空实体返回 null', inj.renderCatalog([]) === null);

// ---- 开局注入：总览 + 标题，正文不展开 ----
const idx2 = new inj.EntityIndex([sharedVault], 0);
const openText = inj.buildInjection({ sharedVaultDir: sharedVault, maxChars: 5000, entityIndex: idx2 });
check('开局注入含实体目录', String(openText).includes('记忆空间里的实体'));
check('开局注入列出实体名', String(openText).includes('攀岩项目'));
check('开局注入【不含实体正文】', !String(openText).includes('攀岩相关的小程序'));
check('开局注入仍含常驻记忆', String(openText).includes('常驻记忆'));

// ---- mem_entity 工具：按需翻页 ----
const tools2 = new Map();
inj.registerMemTools((t) => tools2.set(t.name, t), { sharedDir: sharedVault, index: idx2 });
check('注册了 mem_entity', tools2.has('mem_entity'));
check('共注册 7 个工具', tools2.size === 7, [...tools2.keys()].join(', '));

const entTool = tools2.get('mem_entity');

const q1 = await entTool.execute({ name: '攀岩项目' }, {});
check('按主名查到实体', q1.ok === true && q1.name === '攀岩项目');
check('返回实体正文（此时才展开细节）', String(q1.text).includes('攀岩相关的小程序'));
check('带上一跳邻居', JSON.stringify(q1.neighbors) === JSON.stringify(['高斯泼溅']), JSON.stringify(q1.neighbors));
check(
  '邻居只给名字不展开正文',
  !String(q1.text).split('一跳邻居')[1]?.includes('3D 重建技术'),
  String(q1.text).split('一跳邻居')[1]?.slice(0, 40),
);

const q2 = await entTool.execute({ name: '意识镜' }, {});
check('可按别名查到', q2.ok === true && q2.name === '意识之镜', String(q2.name));

const q3 = await entTool.execute({ name: '不存在的实体' }, {});
check('查不到时 ok:false', q3.ok === false);
check('查不到时列出可选项供纠正', String(q3.reason).includes('攀岩项目'), String(q3.reason));

const q4 = await entTool.execute({ name: '  ' }, {});
check('空名字被拒绝', q4.ok === false);


console.log('\n=== 8g. 自动写入（P4）：来源锚点 + 待确证观察 + 触发判定 ===');

const { mkdirSync } = await import('node:fs');
const ev = (type, data) => ({ type, data });

// ---- 来源锚点：id 递增、旁挂存放、正文带角标 ----
const chatVault = join(HOME, '.dsh-mem', 'spaces', 'chat');
const an1 = mod.appendAnchor(chatVault, { session: 'sess-aaaa1111', turn: 3, at: '2026-09-11T01:00:00.000Z', kind: 'observe' });
const an2 = mod.appendAnchor(chatVault, { session: 'sess-aaaa1111', turn: 7, at: '2026-09-11T02:00:00.000Z', kind: 'observe' });
check('锚点 id 从 1 递增', an1?.id === 1 && an2?.id === 2, `${an1?.id},${an2?.id}`);
check('锚点表落在 raw/anchors.jsonl', existsSync(join(chatVault, 'raw', 'anchors.jsonl')));
const anRead = mod.readAnchors(chatVault);
check('锚点可读回且按 id 升序', anRead.length === 2 && anRead[1].turn === 7, JSON.stringify(anRead.map((a) => a.turn)));
check('锚点带会话与轮次', anRead[0].session === 'sess-aaaa1111' && anRead[0].turn === 3);
check('角标写法是 [^N]', mod.renderAnchorMarker(12) === '[^12]');
check('能从正文里抽出角标', JSON.stringify(mod.parseAnchorMarkers('甲[^3] 乙[^10]')) === '[3,10]');
check('去角标后正文干净（判重口径）', mod.stripAnchorMarkers('- 用户偏好 X。[^3]') === '- 用户偏好 X。');

// ---- 待确证观察：必须带锚点、按日期分组、重复拒绝 ----
const obsPath = join(chatVault, 'observations.md');
const o1 = mod.appendObservation(chatVault, '用户偏好把大改动先出设计方案过目。', 1);
check('写入观察 → ok', o1.ok === true && o1.anchorId === 1);
check('正文带角标', _rf(obsPath, 'utf8').includes('用户偏好把大改动先出设计方案过目。 [^1]'));
check('按日期分组', /## \d{4}-\d{2}-\d{2}/.test(_rf(obsPath, 'utf8')));
const oRead = mod.readObservations(chatVault);
check('读回：文本已去掉角标', oRead[0]?.text === '用户偏好把大改动先出设计方案过目。', oRead[0]?.text);
check('读回：带出锚点号', oRead[0]?.anchorId === 1, String(oRead[0]?.anchorId));

const oDup = mod.appendObservation(chatVault, '用户偏好把大改动先出设计方案过目。', 2);
check('重复 → 拒绝', oDup.ok === false && oDup.reason === 'duplicate', String(oDup.reason));
check('空内容 → 拒绝', mod.appendObservation(chatVault, '   ', 2).reason === 'empty');
const oNoAnchor = mod.appendObservation(chatVault, '一条没有出处的断言。', null);
check('没有锚点 → 拒绝入库', oNoAnchor.ok === false && oNoAnchor.reason === 'no-anchor');
check('被拒的正文没进文件', !_rf(obsPath, 'utf8').includes('一条没有出处的断言'));

const o2 = mod.appendObservation(chatVault, '第二条观察。', 2);
check('同一分组内追加', o2.ok === true && o2.count === 2, String(o2.count));
const oRead2 = mod.readObservations(chatVault);
check('分组下两条都在（顺序保持）', oRead2.length === 2 && oRead2[1].anchorId === 2, JSON.stringify(oRead2.map((o) => o.anchorId)));
check('日期分组没有被写成两个', (_rf(obsPath, 'utf8').match(/^## /gm) ?? []).length === 1);

// ---- mem_observe：落点由外部解析器决定，工具自己没有"选空间"的入口 ----
const projWay = join(HOME, 'projway');
const chatWay = join(HOME, 'chatway');
mkdirSync(projWay, { recursive: true });
mkdirSync(chatWay, { recursive: true });

const agentWith = ({ id = 'sess-write01', origin, events = [] } = {}) => ({
  session: { header: { id, ...(origin ? { origin } : {}) }, ownEvents: () => events },
});
const writeAgent = agentWith({ events: [ev('turn/start', { turn: 9 })] });

const obsTools = new Map();
let obsTarget = { kind: 'chat', dir: chatWay };
mod.registerMemTools((t) => obsTools.set(t.name, t), {
  sharedDir: join(HOME, '.dsh-mem', 'shared'),
  observeResolver: () => obsTarget,
});
check('注册了 mem_observe', obsTools.has('mem_observe'));
const observe = (text, exec) => obsTools.get('mem_observe').execute({ text }, exec);

const ob1 = await observe('用户在 Windows 上要求脚本保持 ASCII。', { agent: writeAgent });
check('mem_observe → ok', ob1.ok === true, JSON.stringify(ob1));
check('回执带锚点号', typeof ob1.anchorId === 'number', String(ob1.anchorId));
check('落进解析器给的空间', ob1.space === 'chat', String(ob1.space));
const writeAnchor = mod.readAnchors(chatWay).find((a) => a.id === ob1.anchorId);
check('锚点自动记下当前会话与轮次', writeAnchor?.session === 'sess-write01' && writeAnchor?.turn === 9, JSON.stringify(writeAnchor));
check('正文写进目标 vault', _rf(join(chatWay, 'observations.md'), 'utf8').includes('脚本保持 ASCII'));

// 换一个解析器 → 同一份代码写去另一个分区。工具没有参数能改变这一点。
obsTarget = { kind: 'project', dir: projWay };
const ob2 = await observe('这个项目的构建脚本要先跑 link。', { agent: writeAgent });
check('落点跟随解析器改变', ob2.ok === true && ob2.space === 'project', JSON.stringify(ob2));
check('写进项目分区', _rf(join(projWay, 'observations.md'), 'utf8').includes('先跑 link'));
check('聊天空间没有被写进项目内容', !_rf(join(chatWay, 'observations.md'), 'utf8').includes('先跑 link'));

const noAgent = await observe('无来源的事实。', {});
check('拿不到会话 → 拒绝写入', noAgent.ok === false && String(noAgent.reason).includes('锚点'), String(noAgent.reason));
check('无来源的正文没有落盘', !_rf(join(projWay, 'observations.md'), 'utf8').includes('无来源的事实'));

const obDup = await observe('这个项目的构建脚本要先跑 link。', { agent: writeAgent });
check('工具层也挡重复', obDup.ok === false && String(obDup.reason).includes('已经'), String(obDup.reason));
check('被拒的重复没有白烧锚点号', mod.readAnchors(projWay).length === 1, String(mod.readAnchors(projWay).length));

// ---- 空间推导：仓库标记命中 → 项目分区；否则聊天空间 ----
const fakeRepo = join(HOME, 'fakerepo');
mkdirSync(join(fakeRepo, '.git'), { recursive: true });
const deep = join(fakeRepo, 'src', 'deep');
mkdirSync(deep, { recursive: true });
const rk = mod.resolveWorkspaceKind(deep, ['.git']);
check('子目录能上溯到仓库根', rk.kind === 'project' && rk.root === fakeRepo, String(rk.root));
check('没有仓库标记 → 聊天空间', mod.resolveWorkspaceKind(HOME, ['.dsh-mem-no-such-marker']).kind === 'chat');
check('没有 cwd → 聊天空间（不猜）', mod.resolveWorkspaceKind(null, ['.git']).kind === 'chat');
const wsVault = mod.ensureWorkspaceVault(HOME, deep, ['.git']);
check('按需建出项目记忆目录', wsVault.kind === 'project' && existsSync(join(wsVault.dir, 'observations.md')), wsVault.dir);
check(
  '项目目录落在 项目记忆/projects/<项目名>/',
  wsVault.dir.replace(/\\/g, '/').endsWith(`/project/projects/${wsVault.name}`) && wsVault.name === 'fakerepo',
  `${wsVault.dir} (name=${wsVault.name})`,
);

// ---- 触发判定 ----
const mkTurn = (toolNames, userText = '帮我改一下这个函数') => [
  ev('turn/start', { turn: 5 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }),
  ev('assistant/message', { message: { content: toolNames.map((n) => ({ type: 'tool-call', name: n })) } }),
];
const opt = (minToolSteps = 5, everyTurns = 3) => ({ minToolSteps, everyTurns });

const s1 = mod.scanTurn(mkTurn(['read', 'edit', 'write', 'bash', 'grep']));
check('数出连续工具步数', s1.toolSteps === 5, String(s1.toolSteps));
check('认出本轮轮次号', s1.turn === 5, String(s1.turn));
check('无标记时 sawReflect=false', s1.sawReflect === false);
// toolSteps 是"本轮最长连续段"：写记忆的工具会**切断当前段**，但已经数过的段不回退。
check('连续段长度取最大值', mod.scanTurn(mkTurn(['read', 'read', 'read', 'read', 'read', 'read'])).toolSteps === 6);
check(
  '写记忆的工具切断当前段',
  mod.scanTurn(mkTurn(['read', 'read', 'read', 'read', 'read', 'mem_observe', 'read'])).toolSteps === 5,
  String(mod.scanTurn(mkTurn(['read', 'read', 'read', 'read', 'read', 'mem_observe', 'read'])).toolSteps),
);

const reflectEvents = [
  ev('turn/start', { turn: 8 }),
  ev('user/message', { source: { kind: 'plugin', plugin: 'dsh-mem' }, content: [{ type: 'text', text: '[mem-reflect] 判断一下。' }] }),
];
const sReflect = mod.scanTurn(reflectEvents);
check('认出反思轮（按来源 + 标记）', sReflect.sawReflect === true);
check('反思轮不算"用户消息"', sReflect.sawUser === false);

check('认出显式记忆意图', mod.shouldReflect(mod.scanTurn(mkTurn([], '记住：以后回答都用中文'))).fire === true);
check('理由写明是用户明说', mod.shouldReflect(mod.scanTurn(mkTurn([], '记住：以后回答都用中文'))).why.includes('明说'));
check('日常提到"记得"不误触发', mod.shouldReflect(mod.scanTurn(mkTurn([], '你还记得上次那个 bug 吗'))).fire === false);
// 实测被误触发过：这是**任务提醒**，不是"记住 X"
check(
  '★「别忘了把 X 加上」不算记忆请求（任务提醒）',
  mod.shouldReflect(mod.scanTurn(mkTurn([], '确定，别忘了把 meow-memory 踩的坑加上'))).fire === false,
);
check('「别忘了我生日」也不再触发（宁可漏，不可扰）', mod.shouldReflect(mod.scanTurn(mkTurn([], '别忘了我生日'))).fire === false);

// ★ 用户拍板：「不要在对话过程中频繁改动 memory……不然都由 dream agent 完成」。
//   所以**轮次级触发已经删掉** —— 工具步数再多、隔再多轮都不该提醒记东西。
check('★★工具步数再多也不触发（轮次级已取消）', mod.shouldReflect(s1).fire === false);
check('★★隔再多轮也不触发（轮次级已取消）', mod.shouldReflect(mod.scanTurn(mkTurn(['read'])), 99).fire === false);
check('拒绝理由写明了是"交给 dream"', mod.shouldReflect(s1).why.includes('dream'), mod.shouldReflect(s1).why);
check('本轮已写过记忆 → 不再反思', mod.shouldReflect(mod.scanTurn(mkTurn(['read', 'edit', 'mem_observe']))).fire === false);
check('已反思轮 → 不再反思（防连环）', mod.shouldReflect(sReflect).fire === false);
check(
  '反思提示词只讲两件事：用户要求 / 与已有记忆冲突',
  mod.buildReflectPrompt().includes('与已有记忆冲突') && mod.buildReflectPrompt().includes('不要写'),
);

const multiTurn = [
  ev('turn/start', { turn: 1 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] }),
  ev('turn/end', { turn: 1 }),
  ev('turn/start', { turn: 2 }),
  ev('user/message', { source: { kind: 'plugin', plugin: 'dsh-mem' }, content: [{ type: 'text', text: '[mem-reflect] 反思' }] }),
  ev('turn/end', { turn: 2 }),
  ev('turn/start', { turn: 3 }),
  ev('turn/start', { turn: 4 }),
];
// 顺便确认：`turnsSinceReflect` 这个跨轮计数器已经删掉了（不是"留着但不用"）
check('跨轮计数器已删除（防止有人再把"每隔N轮记一笔"加回来）', mod.turnsSinceReflect === undefined);
void multiTurn;

// ---- 装上 turn-stopping 并真的 steer ----
const awListeners = [];
const awCtx = {
  logger: { info: () => {}, warn: () => {} },
  on: (e, h) => {
    if (e === 'agent/turn-stopping') awListeners.push(h);
    return () => {};
  },
};
mod.installAutoWrite(awCtx, { enabled: true });
check('装上了 turn-stopping 监听', awListeners.length === 1, String(awListeners.length));

const steered = [];
const fire = (events, header = {}) =>
  awListeners[0]({
    agent: {
      session: { header: { id: 'sess-r1', ...header }, ownEvents: () => events },
      steer: (m) => steered.push(m),
    },
  });

// 用户明说"记住" → 提醒落库
fire(mkTurn([], '记住：以后回答都用中文'));
check('用户明说记住时 steer 了', steered.length === 1, String(steered.length));
check('steer 正文带反思标记', JSON.stringify(steered[0] ?? {}).includes('[mem-reflect]'));
check(
  'steer 来源标成我们的插件',
  steered[0]?.source?.kind === 'plugin' && steered[0]?.source?.plugin === 'dsh-mem',
  JSON.stringify(steered[0]?.source),
);
const prompt = mod.buildReflectPrompt();
check('提示词点名 mem_remember（用户要求那条路径）', prompt.includes('mem_remember'));

// ★ 工具再重也不提醒 —— 这就是"不要在对话过程中频繁改记忆"
steered.length = 0;
fire(mkTurn(['read', 'edit', 'write', 'bash', 'grep']));
check('★重工具轮不再 steer（轮次级已取消）', steered.length === 0, String(steered.length));

steered.length = 0;
fire(mkTurn([], '记住：以后都用中文'), { origin: 'subagent' });
check('子代理会话不触发', steered.length === 0, String(steered.length));

steered.length = 0;
fire(mkTurn(['read']));
check('轻量轮不触发', steered.length === 0, String(steered.length));

steered.length = 0;
fire(reflectEvents);
check('反思轮自身结束不再触发', steered.length === 0, String(steered.length));

let awThrew = false;
try {
  awListeners[0]({ agent: { session: { header: { id: 'x' }, ownEvents: () => mkTurn(['read', 'edit', 'write', 'bash', 'grep']) } } });
} catch {
  awThrew = true;
}
check('拿不到 steer 时只告警、不抛异常（不能打断 agent loop）', awThrew === false);

const awOff = [];
mod.installAutoWrite(
  { logger: { info: () => {}, warn: () => {} }, on: (e, h) => { if (e === 'agent/turn-stopping') awOff.push(h); return () => {}; } },
  { enabled: false, minToolSteps: 5, everyTurns: 3 },
);
check('autoWrite=false 时不装监听', awOff.length === 0, String(awOff.length));


console.log('\n=== 8h. 项目时间线（P4.5）：抄 diff → 一轮一行摘要 + 详情按需取 ===');

const fsm = await import('node:fs'); // 本段要独用的名字都用命名空间，避开前面已解构的同名绑定

// ---- 窄化工具结果里的 diff（自己校验，不引 dsh-tool-fs 的内部模块）----
const goodMeta = { diffs: [{ path: 'src/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }] };
const vd = mod.validateDiffs(goodMeta);
check('从 meta.diffs 抽出改动', vd.length === 1 && vd[0].path === 'src/a.ts', JSON.stringify(vd));
check('旧内容缺失时记为 null（新增/覆盖）', mod.validateDiffs({ diffs: [{ path: 'x', newText: 'n' }] })[0].oldText === null);
check('meta 不是对象 → 空', mod.validateDiffs(null).length === 0 && mod.validateDiffs('x').length === 0);
check('diffs 不是数组 → 空', mod.validateDiffs({ diffs: 'nope' }).length === 0);
check('单项形状不对 → 跳过而不是抛', mod.validateDiffs({ diffs: [null, 1, { path: 2, newText: 'x' }, { path: 'ok', newText: 'y' }] }).length === 1);

// ---- 摘要与详情渲染 ----
const at = new Date(2026, 8, 11, 14, 5);
const oneFile = [{ path: 'src/a.ts', oldText: 'x', newText: 'y' }];
check('摘要写时间 + 文件数 + 名单', mod.summarizeEntry(oneFile, [], at) === '09-11 14:05 · 1 个文件 · src/a.ts', mod.summarizeEntry(oneFile, [], at));
const many = ['a', 'b', 'c', 'd'].map((p) => ({ path: p, oldText: null, newText: 'n' }));
check('文件多于 3 个时报出总数', String(mod.summarizeEntry(many, [], at)).includes('等 4 个'), mod.summarizeEntry(many, [], at));
check('同一文件多处改动只算一个文件', mod.summarizeEntry([{ path: 'a', oldText: null, newText: 'x' }, { path: 'a', oldText: null, newText: 'y' }], [], at).includes('1 个文件'));
check('只有调用没有 diff 时如实说明', mod.summarizeEntry([], ['write'], at).includes('未附 diff'), mod.summarizeEntry([], ['write'], at));

// 摘要是**常驻注入**的，路径必须压短（真机实测：列绝对路径一行 ~150 字符）
const REPO = 'D:\\demo\\MemoryChat';
const absIn = 'D:\\demo\\MemoryChat\\dsh-mem\\src\\vault-api.ts';
const lineIn = mod.summarizeEntry([{ path: absIn, oldText: 'a', newText: 'b' }], [], at, REPO);
check('cwd 之下的路径转成相对', lineIn.includes('dsh-mem/src/vault-api.ts'), lineIn);
const absOut = 'C:\\Users\\MECHREVO\\.dsh\\.dsh-mem\\spaces\\project\\proj\\d--demo-MemoryChat\\timeline.md';
const lineOut = mod.summarizeEntry([{ path: absOut, oldText: 'a', newText: 'b' }], [], at, REPO);
check('cwd 之外的超长路径只留末尾两段', lineOut.includes('…/d--demo-MemoryChat/timeline.md'), lineOut);
check('单条摘要长度受控', lineOut.length < 90, `${lineOut.length} 字符`);
check('cwd 为 null 时也压得住', mod.summarizeEntry([{ path: absOut, oldText: 'a', newText: 'b' }], [], at, null).includes('…/'), '');

const fakeAnchor = { id: 7, session: 'sess-tl-abcdef', turn: 3, at: '2026-09-11T06:05:00.000Z', kind: 'diff' };
const detail = mod.renderDetail(fakeAnchor, oneFile, [], 'D:/demo/x');
check('详情含指针号', detail.includes('[→7]'));
check('详情含会话与轮次', detail.includes('sess-tl-abcdef') && detail.includes('- 轮次：3'));
check('详情同时给改前与改后', detail.includes('**改前**') && detail.includes('**改后**'));
check('详情明确写着不会被主动注入', detail.includes('被主动注入上下文'));
const createDetail = mod.renderDetail(fakeAnchor, [{ path: 'n.ts', oldText: null, newText: 'hello' }], [], null);
check('新增文件只给改后并注明', createDetail.includes('新增或整体覆盖') && !createDetail.includes('**改前**'));

// 围栏不能与正文里的反引号打架（README 里就有三反引号）
const trickyFence = mod.fenced('```\ncode\n```');
check('正文含三反引号时围栏升级为四个', trickyFence.startsWith('````\n') && trickyFence.endsWith('\n````'), JSON.stringify(trickyFence));
check('围栏升级后内容原样保留', trickyFence.includes('```\ncode\n```'));
check('普通正文仍用三个反引号', mod.fenced('plain').startsWith('```\n'));
check('详情也挡超长文本', mod.renderDetail(fakeAnchor, [{ path: 'big.ts', oldText: null, newText: 'x'.repeat(9000) }], [], null).includes('已截断'));

// ---- 采集 → 落盘（一整轮聚合成一条）----
const tlVault = join(HOME, 'tlvault');
mod.ensureSpaceVault(tlVault, 'project-entry');
check('分区模板自带 timeline.md', existsSync(join(tlVault, 'timeline.md')));
const tlSeed = _rf(join(tlVault, 'timeline.md'), 'utf8');
check(
  '时间线骨架是时间线专用的（不被 sections.yaml 的通用占位符覆盖）',
  tlSeed.includes('[→ id]') && !tlSeed.includes('dream 会在确证后填入'),
  JSON.stringify(tlSeed.split('\n').slice(0, 4)),
);

const tlListeners = [];
const tlCtx = {
  logger: { info: () => {}, warn: () => {} },
  on: (e, h) => {
    if (e === 'tools/result' || e === 'agent/turn-stopping') tlListeners.push([e, h]);
    return () => {};
  },
};
mod.installTimeline(tlCtx, { enabled: true, resolveVault: () => tlVault });
const onResult = tlListeners.filter(([e]) => e === 'tools/result').map(([, h]) => h)[0];
const onStopping = tlListeners.filter(([e]) => e === 'agent/turn-stopping').map(([, h]) => h)[0];
check('装上了 tools/result 与 turn-stopping', typeof onResult === 'function' && typeof onStopping === 'function');

const tlEvents = [ev('turn/start', { turn: 3 })];
const tlAgent = { session: { header: { id: 'sess-tl01', cwd: 'D:/demo/x' }, ownEvents: () => tlEvents } };
const tlExec = (name, meta) => ({ name, agent: tlAgent, arguments: {}, meta });

onResult(tlExec('write', { diffs: [{ path: 'src/a.ts', oldText: 'A', newText: 'B' }] }), { meta: { diffs: [{ path: 'src/a.ts', oldText: 'A', newText: 'B' }] } });
onResult(tlExec('edit', { diffs: [{ path: 'src/b.ts', oldText: 'C', newText: 'D' }] }), { meta: { diffs: [{ path: 'src/b.ts', oldText: 'C', newText: 'D' }] } });
onStopping({ agent: tlAgent });

const tlText = _rf(join(tlVault, 'timeline.md'), 'utf8');
const tlLines = tlText.split('\n').filter((l) => l.startsWith('- '));
check('一轮只落一行摘要', tlLines.length === 1, JSON.stringify(tlLines));
check('摘要含两个文件', String(tlLines[0]).includes('2 个文件'), String(tlLines[0]));
check('摘要带 [→N] 指针', /\[→\d+\]/.test(String(tlLines[0])), String(tlLines[0]));

const tlAnchors = mod.readAnchors(tlVault);
check('锚点 kind 记为 diff', tlAnchors.length === 1 && tlAnchors[0].kind === 'diff', JSON.stringify(tlAnchors));
check('锚点带会话与轮次', tlAnchors[0].session === 'sess-tl01' && tlAnchors[0].turn === 3);
const tlDetailPath = join(tlVault, 'raw', 'timeline', `${tlAnchors[0].id}.md`);
check('详情文件写在 raw/timeline/<id>.md', existsSync(tlDetailPath), tlDetailPath);
check('详情含两处改动', _rf(tlDetailPath, 'utf8').includes('src/a.ts') && _rf(tlDetailPath, 'utf8').includes('src/b.ts'));

// 读类工具不进时间线
onResult(tlExec('read', {}), { content: [] });
onStopping({ agent: tlAgent });
check('只有读类工具 → 不产生条目', _rf(join(tlVault, 'timeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).length === 1);

// 改动类工具没带 diff → 退化成记一条调用
onResult(tlExec('move', {}), { content: [] });
onStopping({ agent: tlAgent });
const afterMove = _rf(join(tlVault, 'timeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
check('改动类工具无 diff 时仍留痕', afterMove.length === 2 && String(afterMove[1]).includes('move'), JSON.stringify(afterMove));

// 子代理不记
onResult({ name: 'write', agent: { session: { header: { id: 'sess-sub', origin: 'subagent' }, ownEvents: () => tlEvents } } }, { meta: { diffs: [{ path: 'z', oldText: 'a', newText: 'b' }] } });
onStopping({ agent: { session: { header: { id: 'sess-sub', origin: 'subagent' }, ownEvents: () => tlEvents } } });
check('子代理会话不记时间线', _rf(join(tlVault, 'timeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).length === 2);

// 拿不到工作目录 → 不猜落点
const nullVaultListeners = [];
let warned = '';
mod.installTimeline(
  { logger: { info: () => {}, warn: (m) => { warned = m; } }, on: (e, h) => { if (e === 'tools/result' || e === 'agent/turn-stopping') nullVaultListeners.push([e, h]); return () => {}; } },
  { enabled: true, resolveVault: (cwd) => (cwd === null ? null : tlVault) },
);
const nvResult = nullVaultListeners.filter(([e]) => e === 'tools/result').map(([, h]) => h)[0];
const nvStop = nullVaultListeners.filter(([e]) => e === 'agent/turn-stopping').map(([, h]) => h)[0];
const noCwdAgent = { session: { header: { id: 'sess-nocwd' }, ownEvents: () => tlEvents } };
nvResult({ name: 'write', agent: noCwdAgent }, { meta: { diffs: [{ path: 'q', oldText: 'a', newText: 'b' }] } });
nvStop({ agent: noCwdAgent });
check('拿不到 cwd 时不猜落点、只告警', String(warned).includes('不猜落点'), warned);
check('不猜落点时没有写出半个条目', !_rf(join(tlVault, 'timeline.md'), 'utf8').includes('q'));

// 关闭开关就不装
const offListeners = [];
mod.installTimeline(
  { logger: { info: () => {}, warn: () => {} }, on: (e, h) => { offListeners.push([e, h]); return () => {}; } },
  { enabled: false, resolveVault: () => tlVault },
);
check('timeline=false 时不装采集', offListeners.length === 0 && _rf(join(tlVault, 'timeline.md'), 'utf8').split('\n').filter((l) => l.startsWith('- ')).length === 2);

// ---- mem_diff：按指针取详情 ----
const tlTools = new Map();
mod.registerMemTools((t) => tlTools.set(t.name, t), {
  sharedDir: join(HOME, '.dsh-mem', 'shared'),
  timelineResolver: (cwd) => (cwd === null ? null : tlVault),
});
check('注册了 mem_diff', tlTools.has('mem_diff'));
const memDiff = (args, exec) => tlTools.get('mem_diff').execute(args, exec);

const d1 = await memDiff({ id: tlAnchors[0].id }, { agent: tlAgent });
check('按指针取到详情', d1.ok === true && d1.text.includes('src/a.ts'), JSON.stringify(d1).slice(0, 80));
check('回执带会话与轮次', d1.session === 'sess-tl01' && d1.turn === 3);

const d2 = await memDiff({ id: 999 }, { agent: tlAgent });
check('不存在的指针 → ok:false', d2.ok === false);
check('不存在时列出现有指针', String(d2.reason).includes(String(tlAnchors[0].id)), String(d2.reason));

// 观察类锚点没有详情文件
const obsAnchor = mod.appendAnchor(tlVault, { session: 's', turn: 1, at: 'x', kind: 'observe' });
const d3 = await memDiff({ id: obsAnchor.id }, { agent: tlAgent });
check('观察类锚点 → 说明没有详情文件', d3.ok === false && String(d3.reason).includes('没有详情文件'), String(d3.reason));

// 锚点在但详情被删
const gone = mod.appendAnchor(tlVault, { session: 's', turn: 2, at: 'x', kind: 'diff' });
const gonePath = join(tlVault, 'raw', 'timeline', `${gone.id}.md`);
fsm.writeFileSync(gonePath, 'temp', 'utf8');
fsm.unlinkSync(gonePath);
const d4 = await memDiff({ id: gone.id }, { agent: tlAgent });
check('锚点在但详情被清理 → 如实说', d4.ok === false && String(d4.reason).includes('不在了'), String(d4.reason));

const d5 = await memDiff({ id: 1 }, { agent: { session: { header: { id: 's', cwd: null }, ownEvents: () => [] } } });
check('拿不到工作目录 → 拒绝而不是猜', d5.ok === false && String(d5.reason).includes('工作目录'), String(d5.reason));
check('非法 id → 拒绝', (await memDiff({ id: 0 }, { agent: tlAgent })).ok === false);

// 没有配置 resolver 的工具集：两个落点相关工具都该明确拒绝
const bareTools = new Map();
mod.registerMemTools((t) => bareTools.set(t.name, t), { sharedDir: join(HOME, '.dsh-mem', 'shared') });
check('未配置落点 → mem_observe 拒绝', (await bareTools.get('mem_observe').execute({ text: 'x' }, { agent: tlAgent })).ok === false);
check('未配置落点 → mem_diff 拒绝', (await bareTools.get('mem_diff').execute({ id: 1 }, { agent: tlAgent })).ok === false);

// ---- 端到端：验证 apply 真正装上的监听器（不是我自己在测试里装的那份）----
check('apply 装上了 tools/result 采集', (listeners['tools/result'] ?? []).length === 1, String((listeners['tools/result'] ?? []).length));
check('apply 装上了 turn-stopping（自动写入 + 时间线各一个）', (listeners['agent/turn-stopping'] ?? []).length >= 2, String((listeners['agent/turn-stopping'] ?? []).length));

const e2eAgent = { session: { header: { id: 'sess-e2e', cwd: deep }, ownEvents: () => [ev('turn/start', { turn: 11 })] } };
for (const h of listeners['tools/result'] ?? []) {
  h({ name: 'write', agent: e2eAgent }, { meta: { diffs: [{ path: 'src/z.ts', oldText: 'a', newText: 'b' }] } });
}
for (const h of listeners['agent/turn-stopping'] ?? []) h({ agent: e2eAgent });

const e2eKey = mod.resolveWorkspaceKind(deep, ['.git']).key;
const e2eTimeline = join(HOME, '.dsh-mem', 'spaces', 'project', 'projects', 'fakerepo', 'timeline.md');
check('端到端：apply 的监听器按 cwd 落到项目记忆目录', existsSync(e2eTimeline), e2eTimeline);
check('端到端：该项目的 timeline 里真有这一条', existsSync(e2eTimeline) && _rf(e2eTimeline, 'utf8').includes('src/z.ts'));
check('端到端：写的是 [[deep]] 那个仓库的目录，不是聊天记忆', !existsSync(join(HOME, '.dsh-mem', 'spaces', 'chat', 'timeline.md')));


console.log('\n=== 8i. 分区隔离与跨项目检索（P4.6）===');

// ---- 工作区登记表：解析 / 渲染 / 往返 ----
const reg0 = mod.parseRegistry(
  [
    '# 这是注释',
    'default: project',
    '',
    'spaces:',
    '  "D:/demo/MemoryChat": project',
    "  'd:/chat': chat",
    '  这一行没有冒号',
    '  "D:/bad": 不是类型',
  ].join('\n'),
);
check('解析 default', reg0.default === 'project', reg0.default);
check(
  '解析登记项（盘符统一小写）',
  reg0.spaces['d:/demo/MemoryChat'] === 'project' && reg0.spaces['d:/chat'] === 'chat',
  JSON.stringify(reg0.spaces),
);
check('反斜杠与正斜杠归一', mod.registryKey('D:\\demo\\x') === mod.registryKey('d:/demo/x'), mod.registryKey('D:\\demo\\x'));
check('非法类型行被跳过而不是抛', !('d:/bad' in reg0.spaces));
check('坏 default 回退成 ask', mod.parseRegistry('default: 乱写').default === 'ask');
const roundTrip = mod.parseRegistry(mod.renderRegistry(reg0));
// 注意：不能拿 JSON.stringify 比对象 —— 渲染时会按键排序，键**顺序**不同不代表内容不同。
const sameSpaces = (a, b) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
check(
  '渲染后能解析回来（往返一致）',
  sameSpaces(roundTrip.spaces, reg0.spaces) && roundTrip.default === reg0.default,
  JSON.stringify(roundTrip),
);
check('渲染带解释性注释（给人改的）', mod.renderRegistry(reg0).includes('# dsh-mem 工作区类型登记表'));
check('apply 建出了登记表文件', existsSync(join(HOME, '.dsh-mem', 'workspaces.yaml')));

// ---- 判定顺序：登记表 > 仓库标记 > default ----
mod.setWorkspaceKind(HOME, deep, 'project');
const rExplicit = mod.resolveWorkspace(HOME, deep, ['.git']);
check('登记表压过仓库标记', rExplicit.source === 'explicit' && rExplicit.kind === 'project', rExplicit.source);
check('显式登记时【登记路径就是项目根】（不再往下找 .git）', rExplicit.root === mod.registryKey(deep), `${rExplicit.root}`);
check('登记目录的子目录也算登记在内', mod.resolveWorkspace(HOME, join(deep, 'src'), ['.git']).source === 'explicit');
mod.removeWorkspace(HOME, deep);
const rMarker = mod.resolveWorkspace(HOME, deep, ['.git']);
check('取消登记后回到仓库标记判定', rMarker.source === 'marker' && rMarker.kind === 'project', rMarker.source);

const plainDir = join(HOME, 'plain');
const rAsk = mod.resolveWorkspace(HOME, plainDir, ['.git']);
check('没登记没标记 → unregistered', rAsk.source === 'unregistered', rAsk.source);
check('default=ask 时先按聊天空间兜底（破坏性最小）', rAsk.kind === 'chat', rAsk.kind);

mod.writeRegistry(HOME, { spaces: {}, default: 'project' });
const rDef = mod.resolveWorkspace(HOME, plainDir, ['.git']);
check('default: project → 按目录本身分区', rDef.kind === 'project' && rDef.source === 'default');
check('  且 key 由该目录推导（与别的目录不同）', rDef.key !== rMarker.key, `${rDef.key} vs ${rMarker.key}`);
mod.writeRegistry(HOME, { spaces: {}, default: 'ask' });

// ---- 「问过就不再问」 ----
check('未登记目录：第一次要问', mod.wasAsked(HOME, plainDir) === false);
mod.markAsked(HOME, plainDir);
check('问过之后不再问', mod.wasAsked(HOME, plainDir) === true);
check('状态文件在 .dsh-mem/state.json（不是 vault）', existsSync(join(HOME, '.dsh-mem', 'state.json')));

// ---- 检索：分词与打分 ----
const tk = mod.tokenize('记忆插件 memory plugin');
check('ASCII 连成整词', tk.includes('memory') && tk.includes('plugin'), JSON.stringify(tk));
check('中文切成 bigram', tk.includes('记忆') && tk.includes('忆插') && tk.includes('插件'), JSON.stringify(tk));
check('标点不产生 token', !mod.tokenize('a, b').includes(','));

const srchEntries = [
  { path: 'project:A:sections/goal.md', rel: 'sections/goal.md', space: 'project', project: 'A', kind: 'section', name: '项目目标', status: null, body: '做一个跨会话记忆插件，支持项目隔离。', mtime: 0 },
  { path: 'project:B:sections/goal.md', rel: 'sections/goal.md', space: 'project', project: 'B', kind: 'section', name: '项目目标', status: null, body: '一个跟检索毫无关系的爬虫项目。', mtime: 0 },
  { path: 'chat:sections/values.md', rel: 'sections/values.md', space: 'chat', project: null, kind: 'section', name: '价值观', status: null, body: '在意可验证性，讨厌静默失败。', mtime: 0 },
];
const sHits = mod.searchEntries(srchEntries, '记忆插件');
check('中文检索命中正确的分区', sHits.length > 0 && sHits[0].entry.project === 'A', JSON.stringify(sHits.map((h) => h.entry.project)));
check('不相关的条目不被命中', !sHits.some((h) => h.entry.project === 'B'));
check('摘要取命中位置附近', String(sHits[0].snippet).includes('记忆'), sHits[0].snippet);
check('归属标签能区分空间', mod.labelOf(srchEntries[0]) === '项目·A' && mod.labelOf(srchEntries[2]) === '聊天空间', `${mod.labelOf(srchEntries[0])} / ${mod.labelOf(srchEntries[2])}`);
check('搜不到就是空', mod.searchEntries(srchEntries, '完全不存在的词xyz').length === 0);
check('空查询返回空', mod.searchEntries(srchEntries, '   ').length === 0);

// ---- ★回归：同名文件在不同 vault 里不能互相覆盖（主键必须是复合键）----
const vaultA = join(HOME, 'regA');
const vaultB = join(HOME, 'regB');
mod.ensureSpaceVault(vaultA, 'project-entry');
mod.ensureSpaceVault(vaultB, 'project-entry');
const regDb = mod.openIndex(join(HOME, 'reg.db'));
mod.rebuildVault(regDb, vaultA, 'project', 'regA');
mod.rebuildVault(regDb, vaultB, 'project', 'regB');
const regRows = mod.listEntries(regDb);
check(
  '两个 vault 的同名文件都活着（不再互相覆盖）',
  regRows.some((r) => r.project === 'regA' && r.rel === 'README.md') &&
    regRows.some((r) => r.project === 'regB' && r.rel === 'README.md'),
  `${regRows.length} 行`,
);
check('条目主键是复合键', regRows.every((r) => r.path.startsWith('project:')), regRows[0]?.path);
const rebuildAgain = mod.rebuildVault(regDb, vaultA, 'project', 'regA');
check(
  '重建不会把自己刚插的行删掉（清理必须比 rel 不能比复合键）',
  rebuildAgain.indexed > 0 &&
    rebuildAgain.removed === 0 &&
    mod.listEntries(regDb).some((r) => r.rel === 'README.md' && r.project === 'regA'),
  `indexed=${rebuildAgain.indexed} removed=${rebuildAgain.removed}`,
);
mod.closeIndex(regDb);

// ---- 分区元信息与「别的项目」指针 ----
const pdir = mod.ensureProjectPartition(HOME, 'D:\\demo\\DemoProj', ['.git']);
check('分区建立时写下 meta.yaml', existsSync(join(pdir.dir, 'meta.yaml')));
const pmeta = mod.readProjectMeta(pdir.dir);
check('meta 记下 key 与真实路径', pmeta?.key === pdir.key && String(pmeta?.path).includes('DemoProj'), JSON.stringify(pmeta));
check('meta 推导出可读名', pmeta?.name === 'DemoProj', pmeta?.name);

const projRoot = join(HOME, '.dsh-mem', 'spaces', 'project', 'projects');
const briefs = mod.listProjectBriefs(projRoot, mod.listPartitionKeys(HOME));
const demoBrief = briefs.find((b) => b.key === pdir.key);
check('分区概览带记忆数与时间线数', demoBrief !== undefined && typeof demoBrief.entries === 'number' && typeof demoBrief.timelineCount === 'number');
check('提到别的项目才算命中', mod.mentionedProjects(briefs, null, '你还记得 DemoProj 吗').some((b) => b.key === pdir.key));
check('没提到就不给指针', mod.mentionedProjects(briefs, null, '今天天气不错').length === 0);
check('当前项目自己不算"别的项目"', mod.mentionedProjects(briefs, pdir.key, 'DemoProj 怎么样了').length === 0);
const ptr = mod.renderPointers([demoBrief]);
check('指针只给规模、标明不给正文', String(ptr).includes('条记忆') && String(ptr).includes('mem_search'));
check('空列表不给指针', mod.renderPointers([]) === null);

// ---- mem_space：查看与登记 ----
const spTools = new Map();
mod.registerMemTools((t) => spTools.set(t.name, t), {
  sharedDir: join(HOME, '.dsh-mem', 'shared'),
  workspaces: { home: HOME, markers: ['.git'], entriesDir: projRoot },
});
check('注册了 mem_space', spTools.has('mem_space'));
const spAgent = { session: { header: { id: 'sp', cwd: plainDir }, ownEvents: () => [] } };
const spList = await spTools.get('mem_space').execute({ action: 'list' }, { agent: spAgent });
check('mem_space list 给出判定与依据', spList.ok === true && spList.text.includes('default 策略'), String(spList.text).slice(0, 40));
check('list 列出了已存在的项目分区', String(spList.text).includes('DemoProj'), String(spList.text).slice(0, 200));

const spSet = await spTools.get('mem_space').execute({ action: 'set', path: plainDir, kind: 'project' }, { agent: spAgent });
check('mem_space set → ok', spSet.ok === true, JSON.stringify(spSet));
check('登记后判定变成 explicit', mod.resolveWorkspace(HOME, plainDir, ['.git']).source === 'explicit');
check('登记后是项目分区', mod.resolveWorkspace(HOME, plainDir, ['.git']).kind === 'project');
const spBadKind = await spTools.get('mem_space').execute({ action: 'set', kind: '乱写' }, { agent: spAgent });
check('非法 kind 被拒', spBadKind.ok === false);
check('未配置 workspaces 时拒绝', (await bareTools.get('mem_space').execute({ action: 'list' }, { agent: spAgent })).ok === false);

// ---- mem_search：走 apply 装的那一份（端到端）----
const e2eSearch = registeredTools.get('mem_search');
check('apply 注册了 mem_search', e2eSearch !== undefined);
fsm.writeFileSync(join(chatDir, 'sections', 'values.md'), '# 价值观与人生观\n\n用户在意「可验证性」，讨厌静默失败。\n', 'utf8');
const e2eAgent2 = { session: { header: { id: 'srch', cwd: plainDir }, ownEvents: () => [] } };
const sr1 = await e2eSearch.execute({ query: '可验证性' }, { agent: e2eAgent2 });
check('跨项目检索命中聊天空间', sr1.ok === true && sr1.count > 0, `count=${sr1.count}`);
check('结果带归属标注', String(sr1.text).includes('聊天空间'), String(sr1.text).slice(0, 120));
const sr2 = await e2eSearch.execute({ query: '可验证性', scope: 'current' }, { agent: e2eAgent2 });
check(
  'scope=current 不越界到别的空间',
  !String(sr2.text).includes('聊天空间'),
  `count=${sr2.count}`,
);
check('空 query 被拒', (await e2eSearch.execute({ query: '  ' }, { agent: e2eAgent2 })).ok === false);

// ---- ★端到端：注入真的按当前空间分层，别的分区不进上下文 ----
const drivePreStep = async (agent, userText) => {
  const decision = {
    kind: 'enter',
    messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: userText }] }],
  };
  return (listeners['agent/pre-step'] ?? [])[0]({ agent }, async () => decision);
};
const textOfInjected = (dec) =>
  (dec.messages ?? [])
    .filter((m) => m.source?.kind === 'plugin')
    .map((m) => (m.content ?? []).map((b) => b.text ?? '').join(''))
    .join('\n');

const plainRes = mod.resolveWorkspace(HOME, plainDir, ['.git']);
const plainEntry = mod.ensureProjectEntry(HOME, plainRes.key, plainRes.root ?? '');
const projVaultDir = plainEntry.dir;
check('登记为项目后该目录已建立', existsSync(projVaultDir), projVaultDir);
check('目录名是项目名（人类可读），不是分区 key', projVaultDir.replace(/\\/g, '/').endsWith('/projects/plain'), projVaultDir);
fsm.writeFileSync(join(projVaultDir, 'sections', 'goal.md'), '# 项目目标\n\n做一个叫「星轨」的跨会话记忆插件。\n', 'utf8');
const otherPart = mod.ensureProjectPartition(HOME, 'D:\\demo\\OtherProj', ['.git']);
fsm.writeFileSync(join(otherPart.dir, 'sections', 'goal.md'), '# 项目目标\n\n别的项目的机密内容「蓝鲸」。\n', 'utf8');

mod.resetInjectionState();
const decProj = await drivePreStep(
  { session: { header: { id: 'sess-inj1', cwd: plainDir }, ownEvents: () => [] } },
  '你好',
);
const injProj = textOfInjected(decProj);
// ★ 用户拍板：项目记忆**整体不注入**，平时只注入「常驻记忆 + 全局共用」。
check('★★项目记忆的正文【不注入】（哪怕它是当前项目）', !injProj.includes('星轨'), injProj.slice(0, 200));
check('★别的项目的内容当然也不注入', !injProj.includes('蓝鲸'));
check(
  '项目会话给一行轻量指针，告诉 AI 有东西可以翻',
  injProj.includes('mem_search') && injProj.includes('不在你的上下文里'),
  injProj.slice(0, 260),
);

mod.resetInjectionState();
const decPtr = await drivePreStep(
  { session: { header: { id: 'sess-inj2', cwd: plainDir }, ownEvents: () => [] } },
  '你还记得 OtherProj 那个项目吗',
);
const injPtr = textOfInjected(decPtr);
check('提到别的项目 → 给轻量指针', injPtr.includes('OtherProj'), injPtr.slice(0, 200));
check('★指针只给规模，不给其它项目的正文', !injPtr.includes('蓝鲸'));

mod.resetInjectionState();
const unregDir = join(HOME, 'unregistered-ws');
const decAsk = await drivePreStep(
  { session: { header: { id: 'sess-inj3', cwd: unregDir }, ownEvents: () => [] } },
  '嗨',
);
check('未登记工作区 → 会话里问一次', textOfInjected(decAsk).includes('还没有登记类型'));
mod.resetInjectionState();
const decAsk2 = await drivePreStep(
  { session: { header: { id: 'sess-inj4', cwd: unregDir }, ownEvents: () => [] } },
  '嗨',
);
check('问过之后不再问（不反复打扰）', !textOfInjected(decAsk2).includes('还没有登记类型'));

// ---- 分区实体参与注入（P4.6）----
const entIdx3 = new mod.EntityIndex([join(HOME, '.dsh-mem', 'shared')], 0);
mod.ensureSpaceVault(projVaultDir, 'project-entry');
fsm.mkdirSync(join(projVaultDir, 'entities'), { recursive: true });
fsm.writeFileSync(
  join(projVaultDir, 'entities', '星轨.md'),
  '---\nname: 星轨\nkind: project\nstatus: ongoing\n---\n本项目的代号。\n',
  'utf8',
);
check('不传额外目录时扫不到分区实体', !entIdx3.all().some((e) => e.name === '星轨'));
check('传当前分区后能扫到', entIdx3.all([projVaultDir]).some((e) => e.name === '星轨'));
const entHit = entIdx3.resolve('星轨 做得怎么样了', [projVaultDir]);
check('分区实体参与命中', entHit.hit.some((e) => e.name === '星轨'));


// ---- 空间模型：**只有三个** ----
const apiStub = {
  sharedDir: globalDir,
  chatDir,
  projectDir: join(HOME, '.dsh-mem', 'spaces', 'project'),
  overview: () => ({ projects: [] }),
};
check(
  'resolveSpaceDir 只认 shared / chat / project 三个',
  mod.resolveSpaceDir(apiStub, 'shared') === globalDir &&
    mod.resolveSpaceDir(apiStub, 'chat') === chatDir &&
    mod.resolveSpaceDir(apiStub, 'project') === apiStub.projectDir &&
    mod.resolveSpaceDir(apiStub, 'project:anything') === null &&
    mod.resolveSpaceDir(apiStub, 'project-shared') === null &&
    mod.resolveSpaceDir(apiStub, 'nonsense') === null,
);
check('项目会话注入里不再有「跨项目层」这一层', !injProj.includes('跨项目层'), injProj.slice(0, 200));

// ---- 旧项目目录自动搬家：proj/<key>/ → projects/<项目名>/ ----
const legacyProjRoot = join(HOME, '.dsh-mem', 'spaces', 'project', 'proj');
fsm.mkdirSync(join(legacyProjRoot, 'd--demo-OldProj', 'sections'), { recursive: true });
fsm.writeFileSync(
  join(legacyProjRoot, 'd--demo-OldProj', 'meta.yaml'),
  'key: d--demo-OldProj\npath: d:/demo/OldProj\nname: OldProj\n',
  'utf8',
);
fsm.writeFileSync(join(legacyProjRoot, 'd--demo-OldProj', 'sections', 'goal.md'), '# 项目目标\n\n老项目的内容。\n', 'utf8');
const movedNames = mod.migrateLegacyProjectDirs(HOME);
check('旧项目目录被搬到 projects/ 下', movedNames.includes('OldProj'), JSON.stringify(movedNames));
const newOldDir = join(HOME, '.dsh-mem', 'spaces', 'project', 'projects', 'OldProj');
check('搬到的是人类可读的项目名目录', existsSync(newOldDir), newOldDir);
check('内容一字未改地跟着走了', _rf(join(newOldDir, 'sections', 'goal.md'), 'utf8').includes('老项目的内容'));
check('搬空后旧的 proj/ 被清掉', !existsSync(legacyProjRoot));
check('重复调用是幂等的', mod.migrateLegacyProjectDirs(HOME).length === 0);
fsm.rmSync(newOldDir, { recursive: true, force: true });

// ---- 旧结构迁移告警：不自动搬，但也不静默遗弃 ----
check('新结构下没有旧跨项目层', mod.detectLegacyShared(HOME).exists === false);
const legacyDir = join(HOME, '.dsh-mem', 'spaces', 'project', '_shared');
fsm.mkdirSync(join(legacyDir, 'sections'), { recursive: true });
fsm.writeFileSync(join(legacyDir, 'sections', 'ability.md'), '# 能力画像\n\n_尚未有内容。dream 会在确证后填入。_\n', 'utf8');
check('旧目录只剩模板骨架时不算"有内容"', mod.detectLegacyShared(HOME).hasContent === false);
// 假阳性回归：README / log / observations 天生带大段说明文字，不能拿它们当"有内容"的判据
fsm.writeFileSync(join(legacyDir, 'README.md'), '# 跨项目层\n\n这里放能力画像与项目偏好。\n', 'utf8');
fsm.writeFileSync(join(legacyDir, 'log.md'), '# Dream 日志\n\n每次整理的分阶段记录。vault 不健康时会明确写出来。\n\n---\n', 'utf8');
fsm.writeFileSync(join(legacyDir, 'observations.md'), '# 待确证观察（暂存区）\n\n信号还不够强、只出现过一次、尚未被证实的观察写在这里。\n\n---\n', 'utf8');
check('只有说明性文字也不算有内容（假阳性回归）', mod.detectLegacyShared(HOME).hasContent === false);
// 假阳性回归 2：空目录（raw/timeline/）也会被 listVaultTree 当成条目，必须只数文件
fsm.mkdirSync(join(legacyDir, 'raw', 'timeline'), { recursive: true });
fsm.mkdirSync(join(legacyDir, 'entities'), { recursive: true });
check('只有空目录结构也不算有内容（假阳性回归 2）', mod.detectLegacyShared(HOME).hasContent === false);
fsm.writeFileSync(join(legacyDir, 'observations.md'), '# 待确证观察（暂存区）\n\n---\n\n## 2026-09-11\n\n- 一条真观察 [^1]\n', 'utf8');
check('observations 里真有条目时会被识别', mod.detectLegacyShared(HOME).hasContent === true);
fsm.writeFileSync(join(legacyDir, 'sections', 'ability.md'), '# 能力画像\n\n用户熟悉 TypeScript 与 Node。\n', 'utf8');
check('旧目录的 section 有真实内容时会被识别出来（不静默遗弃）', mod.detectLegacyShared(HOME).hasContent === true);
fsm.rmSync(legacyDir, { recursive: true, force: true });

// ---- ★合并的核心收益：能力画像现在所有会话都读得到 ----
fsm.writeFileSync(join(globalDir, 'sections', 'ability.md'), '# 能力画像\n\n用户熟悉 TypeScript 与 Node。\n', 'utf8');
const projAgent2 = { session: { header: { id: 'sess-merge-p', cwd: plainDir }, ownEvents: () => [] } };
const chatAgent2 = { session: { header: { id: 'sess-merge-c', cwd: join(HOME, 'not-a-project') }, ownEvents: () => [] } };
mod.resetInjectionState();
const decProj3 = await drivePreStep(projAgent2, '继续');
const decChat3 = await drivePreStep(chatAgent2, '继续');
const injProj3 = textOfInjected(decProj3);
const injChat3 = textOfInjected(decChat3);
check('项目会话读到能力画像', injProj3.includes('TypeScript'), injProj3.slice(0, 200));
check('★聊天会话也读到能力画像（合并前读不到）', injChat3.includes('TypeScript'), injChat3.slice(0, 200));
check('聊天会话注入的是「聊天记忆」这一层', injChat3.includes('聊天记忆'), injChat3.slice(0, 200));


console.log('\n=== 8j. 原始轮次采集（给 dream 的素材）===');

// ---- collectTurn：纯函数 ----
const turnEvents = [
  ev('turn/start', { turn: 12 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '把这段逻辑改一下' }] }),
  // 我们自己的注入不算"用户说的话"（否则会被当成用户的要求提炼进去）
  ev('user/message', { source: { kind: 'plugin', plugin: 'dsh-mem' }, content: [{ type: 'text', text: '### 常驻记忆\n1. 用户的名字是兰兰。' }] }),
  ev('assistant/message', {
    message: {
      content: [
        { type: 'text', text: '好，我看看。' },
        { type: 'tool-call', name: 'read' },
        { type: 'tool-call', name: 'edit' },
      ],
    },
  }),
];
const rec0 = mod.collectTurn(turnEvents, { session: 's1', cwd: 'D:/demo/MemoryChat', space: 'project' });
check('收出用户说的话', rec0?.user === '把这段逻辑改一下', JSON.stringify(rec0?.user));
check('★插件自己的注入不算用户消息', !String(rec0?.user).includes('常驻记忆'));
check('收出助手文本', String(rec0?.assistant).includes('我看看'));
check('收出工具名', JSON.stringify(rec0?.tools) === '["read","edit"]', JSON.stringify(rec0?.tools));
check('记下轮次号与空间', rec0?.turn === 12 && rec0?.space === 'project');
check('记下 cwd（dream 靠它判断归属）', rec0?.cwd === 'D:/demo/MemoryChat');
check('空轮次不产生记录', mod.collectTurn([ev('turn/start', { turn: 1 })], { session: 's', cwd: null, space: 'chat' }) === null);

// ---- appendTurn / readTurns ----
// ★ 素材落在**中立的未归属位置**（不在任何 vault 里）—— 归属由 dream 的两个 agent 按内容判断
const turnFile = join(HOME, '.dsh-mem', 'raw', 'turns', 's1.jsonl');
check('追加一轮 → ok', mod.appendTurn(HOME, rec0) === true);
check('落在 .dsh-mem/raw/turns/（shared 与 spaces 之外）', existsSync(turnFile), turnFile);
check(
  '★没有落进任何 vault（不替 agent 预判归属）',
  !existsSync(join(HOME, '.dsh-mem', 'shared', 'raw', 'turns', 's1.jsonl')) &&
    !existsSync(join(HOME, '.dsh-mem', 'spaces', 'chat', 'raw', 'turns', 's1.jsonl')),
);
const back = mod.readTurns(HOME, 's1');
check('读得回来', back.length === 1 && back[0].user === '把这段逻辑改一下');
check('另一个会话读不到（按会话分文件）', mod.readTurns(HOME, 's2').length === 0);
mod.appendTurn(HOME, { ...rec0, turn: 13 });
check('追加是附加不是覆盖', mod.readTurns(HOME, 's1').length === 2);
check(
  '超长文本被截断（素材不是备份）',
  String(mod.collectTurn([ev('turn/start', { turn: 1 }), ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(9000) }] })], { session: 's', cwd: null, space: 'chat' })?.user).includes('截断'),
);

// ---- 端到端：apply 装的那份监听器真的在写 ----
check('apply 装上了 turn-stopping（提醒 + 时间线 + 轮次采集 ≥3）', (listeners['agent/turn-stopping'] ?? []).length >= 3, String((listeners['agent/turn-stopping'] ?? []).length));

const turnAgentEvents = [
  ev('turn/start', { turn: 21 }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '这条应该被原始轮次采集收下来' }] }),
  ev('assistant/message', { message: { content: [{ type: 'tool-call', name: 'read' }] } }),
];
const turnAgent = {
  session: { header: { id: 'sess-turns', cwd: plainDir }, ownEvents: () => turnAgentEvents },
  steer: () => {},
};
for (const h of listeners['agent/turn-stopping'] ?? []) h({ agent: turnAgent });

const e2eTurnsFile = join(HOME, '.dsh-mem', 'raw', 'turns', 'sess-turns.jsonl');
check('★端到端：轮次落进了未归属的 raw/turns/', existsSync(e2eTurnsFile), e2eTurnsFile);
check(
  '★端到端：没有写进项目记忆（项目≠素材仓库）',
  !existsSync(join(projVaultDir, 'raw', 'turns', 'sess-turns.jsonl')),
);
const e2eTurns = mod.readTurns(HOME, 'sess-turns');
check('端到端：内容对得上', e2eTurns.some((r) => String(r.user).includes('这条应该被原始轮次采集收下来')));
check('端到端：标注了它属于项目空间', e2eTurns.some((r) => r.space === 'project'));
check('★采集没有 steer、没有额外轮次', turnAgentEvents.filter((e) => e.type === 'user/message').length === 1);


console.log('\n=== 8k. dream 调度内核（P6 · meow 七条坑的落点）===');

// ---- 时间解析 ----
check('parseClock 认 HH:MM', JSON.stringify(mod.parseClock('03:00')) === '{"hour":3,"minute":0}');
check('parseClock 认单位数', mod.parseClock('9:05')?.hour === 9);
check('parseClock 拒非法值', mod.parseClock('24:00') === null && mod.parseClock('乱写') === null);
check('parseClock 拒缺冒号', mod.parseClock('0300') === null);

// ---- 到点判定 ----
const dAt = { hour: 3, minute: 0 };
const noon = new Date(2026, 8, 11, 12, 0, 0);
const at2am = new Date(2026, 8, 11, 2, 0, 0);
check('没到点 → 不跑', mod.isDue(at2am, dAt, null, 6) === false);
check('过了点且没跑过 → 跑', mod.isDue(noon, dAt, null, 6) === true);
const ranToday = new Date(2026, 8, 11, 3, 5, 0).toISOString();
check('★今天已成功跑过 → 不再跑', mod.isDue(noon, dAt, ranToday, 6) === false);
const ranYesterday = new Date(2026, 8, 10, 3, 5, 0).toISOString();
check('昨天跑的 → 今天照跑', mod.isDue(noon, dAt, ranYesterday, 6) === true);
const ranRecently = new Date(Date.now() - 3600_000).toISOString();
check('★冷却中（1h < 6h）→ 不跑', mod.isDue(new Date(), dAt, ranRecently, 6) === false);
// 注意：冷却为 0 只是"不额外拦"，"今天已成功跑过"那条闸门仍然在 —— 所以这里用昨天的时间戳
check('冷却为 0 时不再额外拦', mod.isDue(noon, dAt, ranYesterday, 0) === true);

// ---- 活跃度 ----
const now0 = new Date();
check('刚有活动 → 不闲置', mod.isIdle(Date.now(), now0, 15) === false);
check('16 分钟没活动 → 闲置', mod.isIdle(Date.now() - 16 * 60_000, now0, 15) === true);
check('从未有活动（0）→ 算闲置', mod.isIdle(0, now0, 15) === true);

// ---- 租约（第 7 条防御）----
const dreamHome = join(HOME, 'dreamhome');
fsm.mkdirSync(dreamHome, { recursive: true });
check('初始没有租约', mod.leaseHeld(dreamHome, now0) === false);
check('取租约成功', mod.acquireLease(dreamHome, 'test', now0) === true);
check('租约被持有', mod.leaseHeld(dreamHome, now0) === true);
check('重入取租约失败（防并发）', mod.acquireLease(dreamHome, 'other', now0) === false);
const expired = new Date(now0.getTime() + (mod.LEASE_MINUTES + 1) * 60_000);
check('★过期租约不算持有（30min 后能抢）', mod.leaseHeld(dreamHome, expired) === false);
check('★过期后能重新取（不会残留在那卡 30 分钟）', mod.acquireLease(dreamHome, 'retry', expired) === true);
mod.releaseLease(dreamHome);
check('释放后租约没了', mod.leaseHeld(dreamHome, now0) === false);

// ---- ★第 2 条防御：失败不记账 ----
mod.recordSuccess(dreamHome, now0);
check('成功后记下 lastRunAt', mod.readState(dreamHome).dream.lastRunAt !== null);
const okStamp = mod.readState(dreamHome).dream.lastRunAt;
check('成功顺带清租约', mod.readState(dreamHome).dream.lease === null);
mod.acquireLease(dreamHome, 'x', now0);
mod.recordFailure(dreamHome, 'error');
check('★★失败【不动】lastRunAt（否则一次断网永久吞掉当晚）', mod.readState(dreamHome).dream.lastRunAt === okStamp);
check('失败会清租约（下周期可重试）', mod.readState(dreamHome).dream.lease === null);
check('失败记下原因', mod.readState(dreamHome).dream.lastOutcome === 'error');
mod.recordFailure(dreamHome, 'aborted');
check('★中止也清租约（第 7 条防御）', mod.readState(dreamHome).dream.lease === null);

// ---- 素材扫描 ----
const freshHome = join(HOME, 'dreamfresh');
fsm.mkdirSync(join(freshHome, '.dsh-mem', 'raw', 'turns'), { recursive: true });
check('没有素材 → 空', mod.listPendingSessions(freshHome, null).length === 0);
fsm.writeFileSync(join(freshHome, '.dsh-mem', 'raw', 'turns', 'sess-a.jsonl'), '{"session":"sess-a"}\n', 'utf8');
check('有素材就列出来', JSON.stringify(mod.listPendingSessions(freshHome, null)) === '["sess-a"]');
check('★比 lastRunAt 旧的素材不算（跑过就不用重跑）', mod.listPendingSessions(freshHome, new Date().toISOString()).length === 0);

// ---- judge 的闸门顺序 ----
const gHome = join(HOME, 'dreamgate');
fsm.mkdirSync(join(gHome, '.dsh-mem', 'raw', 'turns'), { recursive: true });
const gOpts = { at: { hour: 3, minute: 0 }, idleMinutes: 15, cooldownHours: 6 };
const late = new Date(2026, 8, 11, 12, 0, 0);
check(
  '没素材 → 直接跳过（不烧钱）',
  mod.judge(gHome, gOpts, late, 0).why.includes('没有新素材'),
  mod.judge(gHome, gOpts, late, 0).why,
);
fsm.writeFileSync(join(gHome, '.dsh-mem', 'raw', 'turns', 'sess-b.jsonl'), '{}\n', 'utf8');
check('刚有活动 → 推迟', mod.judge(gHome, gOpts, late, Date.now()).why.includes('还有活动'));
const ok1 = mod.judge(gHome, gOpts, late, 0);
check('★四道闸门都过 → 该跑，并报出待办会话', ok1.proceed === true && ok1.pending.includes('sess-b'), JSON.stringify(ok1));
check('没到点 → 不跑', mod.judge(gHome, gOpts, new Date(2026, 8, 11, 2, 0, 0), 0).proceed === false);

// ---- 第 5 条防御：插件自己的消息不算活跃 ----
const actListeners = [];
const dCtx = {
  logger: { info: () => {}, warn: () => {} },
  on: (e, h) => {
    if (e === 'session/event') actListeners.push(h);
    return () => {};
  },
};
const claimed = [];
mod.installDream(dCtx, {
  enabled: true,
  home: gHome,
  ...gOpts,
  run: async (pending) => {
    claimed.push(...pending);
    return 'ok';
  },
});
check('装了 session/event 活跃度监听', actListeners.length === 1);
const fakeCtx2 = [];
mod.installDream(
  { logger: { info: (m) => fakeCtx2.push(m), warn: (m) => fakeCtx2.push(m) }, on: () => () => {} },
  { enabled: true, home: gHome, ...gOpts },
);
check(
  '★定时路径没接上时【明确说清楚】，不空转一夜；且说明手动入口仍可用',
  fakeCtx2.some((m) => m.includes('未装定时执行') && m.includes('mem_dream')),
  fakeCtx2.join(' | '),
);


console.log('\n=== 8l. dream 的解析与校验（模型输出的那一半）===');

// ---- 模板渲染 ----
check('renderTemplate 替换占位符', mod.renderTemplate('a={{x}} b={{y}}', { x: '1', y: '2' }) === 'a=1 b=2');
check(
  '认不出的占位符原样留着（好过静默消失）',
  mod.renderTemplate('{{nope}}', {}).includes('{{nope}}'),
);

// ---- 从模型输出里抠 JSON（真实输出常带解释与围栏）----
check('裸 JSON 能解析', mod.extractJson('{"space":"chat"}')?.space === 'chat');
check('带 ```json 围栏能解析', mod.extractJson('好的：\n```json\n{"space":"chat"}\n```\n以上。')?.space === 'chat');
check('围栏外还有别的花括号也不慌', mod.extractJson('先看 {这个} 再说\n```\n{"space":"project"}\n```')?.space === 'project');
check(
  '无围栏时扫描第一个平衡花括号',
  mod.extractJson('说明 {不是JSON} 然后 {"space":"chat","observations":[]} 结尾')?.space === 'chat',
);
check('字符串里的花括号不破坏配对', mod.extractJson('{"a":"}{","space":"chat"}')?.space === 'chat');
check('解析不出就 null', mod.extractJson('完全没有 JSON') === null);
check('数组不算（要的是对象）', mod.extractJson('[1,2,3]') === null);

// ---- 校验与归一化 ----
const goodRaw = {
  session: 's1',
  space: 'project',
  project: 'MemoryChat',
  observations: [
    { text: '用户偏好先出设计方案', anchor: 12, kind: 'preference', confidence: 'high', alreadyKnown: false },
    { text: '   ', anchor: 3 }, // 空文本 → 丢弃
    { text: '一条低信度的', anchor: 'not-a-number', confidence: '乱写' }, // 归一化
  ],
  skipped: [{ turn: 37, why: '一次性状态' }, { turn: 38 }],
};
const vGood = mod.validateExtract(goodRaw, 'fallback');
check('合法输出通过', vGood.ok === true, JSON.stringify(vGood.errors));
check('空文本的观察被丢掉', vGood.result.observations.length === 2, String(vGood.result.observations.length));
check('anchor 非数字归一成 null', vGood.result.observations[1].anchor === null);
check('confidence 乱写回退成 low', vGood.result.observations[1].confidence === 'low');
check('skipped 缺理由时补一句（便于分辨偷懒）', String(vGood.result.skipped[1].why).includes('没写理由'));
check('session 缺失时用兜底值', mod.validateExtract({ space: 'chat' }, 'sess-x').result.session === 'sess-x');

const vBadSpace = mod.validateExtract({ space: '乱写' }, 's');
check('★space 不合法 → 拒收', vBadSpace.ok === false && String(vBadSpace.errors[0]).includes('space'));
check('observations 不是数组 → 拒收', mod.validateExtract({ space: 'chat', observations: 'nope' }, 's').ok === false);
check('没解析出 JSON → 拒收', mod.validateExtract(null, 's').ok === false);

// ---- ★锚点核对：模型很容易编号，必须宿主验 ----
const anchorsForCheck = [
  { id: 1, session: 's', turn: 1, at: 'x', kind: 'observe' },
  { id: 7, session: 's', turn: 2, at: 'x', kind: 'diff' },
];
const withBadAnchor = mod.validateExtract(
  { space: 'chat', observations: [{ text: 'a', anchor: 7 }, { text: 'b', anchor: 999 }, { text: 'c', anchor: 42 }] },
  's',
).result;
check('★挑出编造的锚点号', JSON.stringify(mod.missingAnchors(withBadAnchor, anchorsForCheck)) === '[42,999]');
check('全是真锚点时为空', mod.missingAnchors(mod.validateExtract({ space: 'chat', observations: [{ text: 'a', anchor: 1 }] }, 's').result, anchorsForCheck).length === 0);
check('没有锚点的观察不算"编造"（它是"没出处"，另有处置）', mod.missingAnchors(mod.validateExtract({ space: 'chat', observations: [{ text: 'a' }] }, 's').result, anchorsForCheck).length === 0);

// ---- 按 space 归拢 ----
const exA = mod.validateExtract({ session: 's1', space: 'chat', observations: [{ text: '甲' }] }, 's1').result;
const exB = mod.validateExtract({ session: 's1', space: 'project', project: 'P', observations: [{ text: '乙' }] }, 's1').result;
const grouped = mod.groupBySpace([exA, exB]);
check('按 space 归拢', grouped.chat.length === 1 && grouped.project.length === 1);

// ---- 跨会话去重 + 信度升级 ----
const merged = mod.dedupeObservations([
  mod.validateExtract({ session: 's1', space: 'chat', observations: [{ text: '用户偏好先出设计方案', anchor: 1, confidence: 'low' }] }, 's1').result,
  mod.validateExtract({ session: 's2', space: 'chat', observations: [{ text: '用户偏好先出设计方案', anchor: 2, confidence: 'medium' }] }, 's2').result,
  mod.validateExtract({ session: 's2', space: 'chat', observations: [{ text: '另一条', anchor: 3 }] }, 's2').result,
]);
check('★重复的观察合成一条', merged.length === 2, JSON.stringify(merged.map((m) => m.text)));
check('★被两个会话独立提到 → seenIn=2（这就是"确证"）', merged[0].seenIn === 2, String(merged[0].seenIn));
check('★信度取更高的那个', merged[0].confidence === 'medium', merged[0].confidence);
check('两个来源锚点都留下', JSON.stringify(merged[0].anchors) === '[1,2]', JSON.stringify(merged[0].anchors));


// ---- 跳过整理（会话菜单里那个开关）----
const skipHome = join(HOME, 'dreamskip');
fsm.mkdirSync(join(skipHome, '.dsh-mem', 'raw', 'turns'), { recursive: true });
for (const sid of ['keep-me', 'skip-me']) {
  fsm.writeFileSync(join(skipHome, '.dsh-mem', 'raw', 'turns', `${sid}.jsonl`), '{}\n', 'utf8');
}
check('两个会话都在候选里', JSON.stringify(mod.listPendingSessions(skipHome, null)) === '["keep-me","skip-me"]');
check('初始跳过名单为空', mod.readDreamSkip(skipHome).length === 0);
mod.setDreamSkip(skipHome, 'skip-me', true);
check('★标记后不再进候选', JSON.stringify(mod.listPendingSessions(skipHome, null)) === '["keep-me"]', JSON.stringify(mod.listPendingSessions(skipHome, null)));
check('名单落进 state.json', JSON.stringify(mod.readDreamSkip(skipHome)) === '["skip-me"]');
mod.setDreamSkip(skipHome, 'skip-me', false);
check('取消后回到候选', mod.listPendingSessions(skipHome, null).length === 2);
check('取消后名单清空', mod.readDreamSkip(skipHome).length === 0);
check('重复标记不产生重复项', (() => { mod.setDreamSkip(skipHome, 'a', true); mod.setDreamSkip(skipHome, 'a', true); return mod.readDreamSkip(skipHome).length === 1; })());


console.log('\n=== 10. 消息原文（turns）与对话（sessions）—— §5.8 索引三层 ===');
// 这两张表是"RCC 的关键词匹配面"与"场编排/截断判定"的落点：
// 关键词匹配索引的是**消息原文**，再回查这一场有没有被 [TL;DR] 裁过。
const th = join(HOME, 'turns-home');
fsm.mkdirSync(join(th, '.dsh-mem', 'raw', 'turns'), { recursive: true });
const tline = (o) => `${JSON.stringify(o)}\n`;
fsm.writeFileSync(
  join(th, '.dsh-mem', 'raw', 'turns', 's1.jsonl'),
  tline({ session: 's1', turn: 1, at: '2026-09-14T01:00:00.000Z', cwd: 'D:\\x', space: 'project', user: '第一句', assistant: '回一', tools: ['read'] }) +
    tline({ session: 's1', turn: 2, at: '2026-09-14T01:05:00.000Z', cwd: 'D:\\x', space: 'project', user: '第二句', assistant: '回二', tools: [] }),
  'utf8',
);
fsm.writeFileSync(
  join(th, '.dsh-mem', 'raw', 'turns', 's2.jsonl'),
  tline({ session: 's2', turn: null, at: '2026-09-14T02:00:00.000Z', cwd: null, space: 'chat', user: '聊天那句', assistant: '聊天回', tools: [] }),
  'utf8',
);

const tdb = mod.openIndex(join(th, 'index.db'));
const built = mod.rebuildTurns(tdb, th);
check('从 raw/turns 重建出全部轮次', built.indexed === 3 && built.scanned === 2, `indexed=${built.indexed} scanned=${built.scanned}`);
check('按场取轮只给这一场', mod.listTurns(tdb, { session: 's1' }).length === 2);
check(
  'user 与 ai 分列存放（RCC 硬约束）',
  (() => { const t = mod.listTurns(tdb, { session: 's1' })[0]; return t.userText === '第一句' && t.aiCompact === '回一'; })(),
);
check('轮次按时间正序', mod.listTurns(tdb, { session: 's1' }).map((t) => t.turn).join(',') === '1,2');
check('turn 取不到时为 null（所以主键不能拿它）', mod.listTurns(tdb, { session: 's2' })[0].turn === null);
check('tools 存成 JSON 数组', JSON.stringify(mod.listTurns(tdb, { session: 's1' })[0].tools) === '["read"]');
check(
  '会话行自动建出来，started_at 取最早那轮',
  mod.getSession(tdb, 's1')?.startedAt === Date.parse('2026-09-14T01:00:00.000Z'),
  String(mod.getSession(tdb, 's1')?.startedAt),
);

// ★保列重建：project / covered_by 是**回写**的状态（dream 判归属、§5.7 写覆盖），
//   不是文件派生的 —— 重建不许把它们抹掉（直接 delete+insert 就会抹掉）。
tdb.prepare("UPDATE turns SET project = 'MemoryChat', covered_by = 'L1-3' WHERE session = 's1' AND turn = 1").run();
mod.rebuildTurns(tdb, th);
const keptRow = mod.listTurns(tdb, { session: 's1' })[0];
check('★重建保留回写的 project', keptRow.project === 'MemoryChat', String(keptRow.project));
check('★重建保留回写的 covered_by', keptRow.coveredBy === 'L1-3', String(keptRow.coveredBy));

// RCC 状态：拼完之后回写，之后**每轮查表** —— 不重算（按 token 裁不保证重放一致）
mod.setRccState(tdb, ['s1', 's2'], { inRcc: true, truncated: true });
check('RCC 覆盖的场查得到', mod.listRccSessions(tdb).length === 2);
check('截断状态可查（补丁链路的第二步）', mod.listRccSessions(tdb).every((s) => s.rccTruncated === true));
check('RCC 列表按时间正序（旧→新）', mod.listRccSessions(tdb).map((s) => s.session).join(',') === 's1,s2');
mod.setRccState(tdb, ['s2'], { inRcc: false });
check('移出 RCC 后不再出现', mod.listRccSessions(tdb).length === 1 && mod.listRccSessions(tdb)[0].session === 's1');
check('sessions 不因 rebuildTurns 被清（它**不是**派生表）', mod.getSession(tdb, 's1')?.inRcc === true);

// 清理：素材文件没了，索引里的行也要没
fsm.rmSync(join(th, '.dsh-mem', 'raw', 'turns', 's2.jsonl'));
const pruned = mod.rebuildTurns(tdb, th);
check(
  '文件删掉后索引里的行也清掉',
  pruned.removed === 1 && mod.listTurns(tdb).length === 2,
  `removed=${pruned.removed} 剩 ${mod.listTurns(tdb).length}`,
);
mod.closeIndex(tdb);


console.log('\n=== 11. agent preset 定空间（§4.2.7）===');
// 用户选「聊天模式」preset 就是**明确声明**"这是聊天" —— 比从 cwd 猜准。
// 判定入口仍是 `resolveWorkspace`（唯一入口），只是多收一个 preset id。
const mk = ['.git'];
const cwdRepo = join(HOME, 'fakerepo');
const asChat = mod.resolveWorkspace(HOME, cwdRepo, mk, 'chat');
const noPreset = mod.resolveWorkspace(HOME, cwdRepo, mk, null);
check(
  '★ preset=chat 直接判成聊天空间，且理由记为 preset',
  asChat.kind === 'chat' && asChat.source === 'preset',
  `${asChat.kind}/${asChat.source}`,
);
check(
  '不传 preset 时原样走 cwd 那套（不会被 preset 那条路截走）',
  noPreset.source !== 'preset',
  `${noPreset.kind}/${noPreset.source}`,
);
check(
  '别的 preset id 不受影响（只有 chat 才改判）',
  mod.resolveWorkspace(HOME, cwdRepo, mk, 'standard').source !== 'preset',
);
check(
  'preset=chat 时不看 cwd（连 null 也是聊天空间）',
  mod.resolveWorkspace(HOME, null, mk, 'chat').source === 'preset',
);
check(
  'preset 是空串时按"没读到"处理（回退，不误判）',
  mod.resolveWorkspace(HOME, cwdRepo, mk, '').source !== 'preset',
);


console.log('\n=== 12. 官方日志取原文 + 历史回填（§5.9）===');
// 关键前提：DSH 日志是【多帧 zstd】——每个事件一帧。zstdDecompressSync 只解第一帧，
// 而且**不报错**。所以先把这个陷阱本身断言出来，再验逐帧解。
const zlib = await import('node:zlib');
const hist = join(HOME, 'hist-home');
fsm.mkdirSync(join(hist, 'sessions', '--D-x--', 'DIR-NAME-NOT-ID'), { recursive: true });
const histT0 = Date.parse('2026-09-15T10:00:00.000Z');
const histLine = (o) => `${JSON.stringify(o)}\n`;
const histEvents = [
  { type: 'session', version: 3, id: 'session-aaa', createdAt: histT0, cwd: 'D:\\x' },
  { type: 'turn/start', seq: 5, time: histT0, data: { turn: 1 } },
  { type: 'user/message', seq: 6, time: histT0 + 1000, data: { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } } },
  { type: 'user/message', seq: 7, time: histT0 + 1500, data: { content: [{ type: 'text', text: '插件注入，不算用户说的' }], source: { kind: 'plugin', plugin: 'dsh-mem' } } },
  { type: 'assistant/message', seq: 8, time: histT0 + 2000, data: { turn: 1, message: { content: [{ type: 'reasoning', text: '内心戏' }, { type: 'text', text: '回一' }, { type: 'tool-call', name: 'read' }] } } },
  { type: 'turn/start', seq: 9, time: histT0 + 60000, data: { turn: 2 } },
  { type: 'user/message', seq: 10, time: histT0 + 61000, data: { content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 11, time: histT0 + 62000, data: { turn: 2, message: { content: [{ type: 'text', text: '回二' }] } } },
];
const histLogPath = join(hist, 'sessions', '--D-x--', 'DIR-NAME-NOT-ID', 'session.v3.jsonl.zstd');
fsm.writeFileSync(
  histLogPath,
  Buffer.concat(histEvents.map((e) => zlib.zstdCompressSync(Buffer.from(histLine(e), 'utf8')))),
);
const histBuf = fsm.readFileSync(histLogPath);
const oneFrame = zlib.zstdDecompressSync(histBuf).toString().split('\n').filter(Boolean).length;
check('★ 一次解压只拿到 1 条事件（多帧 zstd 的坑，实测过）', oneFrame === 1, `${oneFrame} 条`);
const histDecoded = mod.decodeZstdFrames(histBuf);
check(
  '★ 逐帧解拿到全部事件',
  histDecoded.split('\n').filter(Boolean).length === histEvents.length,
  `${histDecoded.split('\n').filter(Boolean).length} 条`,
);

const histLogs = mod.listSessionLogs(hist);
check(
  '★ 会话 id 取自日志内的 session 事件，【不是】目录名（两者故意不同，防兜底值伪装成正确）',
  histLogs.length === 1 && histLogs[0].session === 'session-aaa',
  JSON.stringify(histLogs.map((l) => l.session)),
);
check('顺带读出 cwd（历史回填靠它定 space）', histLogs[0]?.cwd === 'D:\\x', String(histLogs[0]?.cwd));

const recall1 = mod.recallTurn(hist, 'session-aaa', 1);
check('按 (session, turn) 取回第 1 轮', recall1.ok === true, recall1.reason);
check('★ 取回的是用户原话（插件注入不算）', recall1.user === '第一句', recall1.user);
check('助手文本排除 reasoning 块', recall1.assistant === '回一', recall1.assistant);
check('取回那一轮调过的工具', JSON.stringify(recall1.tools) === '["read"]', JSON.stringify(recall1.tools));
check('取回带时间戳（指针的另一半）', typeof recall1.at === 'string' && recall1.at.startsWith('2026-09-15'), recall1.at);
check(
  '取不存在的轮次时列出现有轮次',
  (() => { const r = mod.recallTurn(hist, 'session-aaa', 99); return r.ok === false && r.reason.includes('1、2'); })(),
);
check('取不存在的会话时明确说没有', mod.recallTurn(hist, 'session-nope', 1).ok === false);

const backfill1 = mod.backfillRawTurns(hist);
check('回填把官方日志灌进 raw/turns', backfill1.added === 2 && backfill1.touched === 1, JSON.stringify(backfill1));
check('回填后 raw/turns 里真有这个会话', mod.readTurns(hist, 'session-aaa').length === 2);
check(
  '回填按时间正序（更早的轮次追加在后面也要排对）',
  mod.readTurns(hist, 'session-aaa').map((t) => t.turn).join(',') === '1,2',
);
check('回填记下空间线索（有 cwd → project）', mod.readTurns(hist, 'session-aaa')[0].space === 'project');
const backfill2 = mod.backfillRawTurns(hist);
check('★ 第二次回填跳过（日志字节数没变 → 不必再解压）', backfill2.added === 0 && backfill2.skipped === 1, JSON.stringify(backfill2));

// ★★ 子代理会话绝不进素材：在线采集那条路有 `isSubagentSession` 挡着，
//    回填这条路**也必须挡** —— 否则 dream 的提示词会被当成"用户发言"回填进来（自噬）。
const subDir = join(hist, 'sessions', '--D-x--', 'SUB-AGENT');
fsm.mkdirSync(subDir, { recursive: true });
const subEvents = [
  { type: 'session', version: 3, id: 'session-sub', createdAt: histT0, cwd: 'D:\\x', delegationDepth: 1 },
  { type: 'turn/start', seq: 5, time: histT0, data: { turn: 1 } },
  { type: 'user/message', seq: 6, time: histT0 + 1000, data: { content: [{ type: 'text', text: '[mem-dream:merge] 你是记忆整理第二阶段的执行者' }], source: { kind: 'user' } } },
];
fsm.writeFileSync(
  join(subDir, 'session.v3.jsonl.zstd'),
  Buffer.concat(subEvents.map((e) => zlib.zstdCompressSync(Buffer.from(histLine(e), 'utf8')))),
);
// 先把"已经脏了"的素材造出来（模拟修复之前已经回填过）
fsm.writeFileSync(
  join(hist, '.dsh-mem', 'raw', 'turns', 'session-sub.jsonl'),
  histLine({ session: 'session-sub', turn: 1, at: new Date(histT0).toISOString(), cwd: 'D:\\x', space: 'project', user: '脏素材（dream 的提示词）', assistant: '', tools: [] }),
  'utf8',
);
const backfill3 = mod.backfillRawTurns(hist);
check(
  '★ 子代理会话（delegationDepth > 0）不进素材',
  mod.readTurns(hist, 'session-sub').length === 0,
  `${mod.readTurns(hist, 'session-sub').length} 轮`,
);
check('★ 已经脏了的子代理素材被清掉（自愈，不只挡新的）', backfill3.pruned === 1, JSON.stringify(backfill3));
check('正常会话不受影响（没被误删）', mod.readTurns(hist, 'session-aaa').length === 2);

// ★ 同一轮落两行：在线采集的 `at` 是写入时刻、回填的是日志 turn/start 时刻，
//   两者天然不同 → 主键 (session, at) 挡不住 → 表里比真实轮数多出若干行（真踩过）。
const dupHome = join(HOME, 'dup-home');
fsm.mkdirSync(join(dupHome, '.dsh-mem', 'raw', 'turns'), { recursive: true });
const dupFile = join(dupHome, '.dsh-mem', 'raw', 'turns', 's-dup.jsonl');
const dupRec = (at, ai) => histLine({ session: 's-dup', turn: 7, at, cwd: null, space: 'chat', user: '同一轮', assistant: ai, tools: [] });
fsm.writeFileSync(dupFile, dupRec('2026-09-15T01:00:00.000Z', '短') + dupRec('2026-09-15T01:00:40.000Z', '更全的一份'), 'utf8');
const dupRead = mod.readTurns(dupHome, 's-dup');
check('★ 读的时候按轮次号去重（同一轮只留一份）', dupRead.length === 1, `${dupRead.length} 行`);
check('★ 去重保留【更全】的那一份', dupRead[0].assistant === '更全的一份', dupRead[0].assistant);
// 写入口也判重：同一轮再写一次不该多出行
mod.appendTurn(dupHome, { session: 's-dup', turn: 7, at: '2026-09-15T02:00:00.000Z', cwd: null, space: 'chat', user: '同一轮', assistant: '又一份', tools: [] });
check(
  '★ 写入口也判重（同一轮再写不会多出一行）',
  fsm.readFileSync(dupFile, 'utf8').split('\n').filter(Boolean).length === 2,
  `${fsm.readFileSync(dupFile, 'utf8').split('\n').filter(Boolean).length} 行`,
);
const dupDb = mod.openIndex(join(dupHome, 'index.db'));
mod.rebuildTurns(dupDb, dupHome);
check('★ 索引层同样按轮次号去重（表里不多行）', mod.listTurns(dupDb).length === 1, `${mod.listTurns(dupDb).length} 行`);
mod.closeIndex(dupDb);


console.log('\n=== 13. RCC 拼装与补丁（§5.8）===');
const rccH = join(HOME, 'rcc-home');
fsm.mkdirSync(join(rccH, '.dsh-mem', 'raw', 'turns'), { recursive: true });
const rccLine = (o) => `${JSON.stringify(o)}\n`;
// 三场，**最旧的那场故意最短** —— 这样"超预算先丢最旧的"才是在测**年龄**而不是测大小。
// 最长的一轮（会被裁）放在**最新**的 s3 里，且含"机票价格"。
const rccPad = '啰'.repeat(400);
fsm.writeFileSync(
  join(rccH, '.dsh-mem', 'raw', 'turns', 'rcc-s1.jsonl'),
  rccLine({ session: 'rcc-s1', turn: 1, at: '2026-09-10T01:00:00.000Z', cwd: null, space: 'chat', user: '今天天气不错', assistant: '回', tools: [] }) +
    rccLine({ session: 'rcc-s1', turn: 2, at: '2026-09-10T01:05:00.000Z', cwd: null, space: 'chat', user: '第二句', assistant: '回', tools: [] }),
  'utf8',
);
fsm.writeFileSync(
  join(rccH, '.dsh-mem', 'raw', 'turns', 'rcc-s2.jsonl'),
  rccLine({ session: 'rcc-s2', turn: 1, at: '2026-09-11T01:00:00.000Z', cwd: null, space: 'chat', user: '记忆插件那件事', assistant: '回', tools: [] }),
  'utf8',
);
fsm.writeFileSync(
  join(rccH, '.dsh-mem', 'raw', 'turns', 'rcc-s3.jsonl'),
  rccLine({ session: 'rcc-s3', turn: 1, at: '2026-09-12T01:00:00.000Z', cwd: null, space: 'chat', user: `机票价格比较：${rccPad} 结尾标记`, assistant: '回', tools: [] }),
  'utf8',
);
const rccDb = mod.openIndex(join(rccH, 'index.db'));
mod.rebuildTurns(rccDb, rccH);

// ---- 掐中段（单位是【一条发言】，头 60 字 + 尾 40 字）----
const cutShort = mod.cutMiddle('短短一句', 60, 40);
check('短文本原样不动', cutShort.truncated === false && cutShort.text === '短短一句');
const cutLong = mod.cutMiddle(rccPad, 60, 40);
check(
  '★ 长文本掐中段并留显式标记，但标记里**不带"省略 N 字"**（那也吃 token）',
  cutLong.truncated === true && cutLong.text.includes(mod.RCC_TRUNCATED) && !cutLong.text.includes('省略'),
);
check('头 60 + 尾 40：掐完就是 100 字加标记', cutLong.text.startsWith(rccPad.slice(0, 60)) && cutLong.text.endsWith(rccPad.slice(-40)), String(cutLong.text.length));
check('头尾都留住了（掐的只是中段）', cutLong.text.startsWith('啰啰') && cutLong.text.endsWith('啰啰'));
check('头尾都给 0 时不裁（取完整原文用）', mod.cutMiddle(rccPad, 0, 0).truncated === false);

// ---- 编号与标题 ----
check('场编号是 MMDDT HH:mm', mod.sessionStamp(Date.parse('2026-09-03T20:10:00')) === '0903T20:10', mod.sessionStamp(Date.parse('2026-09-03T20:10:00')));
check('分隔符是 ||||（用户给的形态）', mod.RCC_SEP === '||||');
const rccS1Turns = mod.listTurns(rccDb, { session: 'rcc-s1' });
const rccS3Turns = mod.listTurns(rccDb, { session: 'rcc-s3' });
check(
  '一场的用户发言用 |||| 连起来（单轮的场没有分隔符，所以拿两轮的场测）',
  mod.sessionUserText(rccS1Turns).text.includes(`\n${mod.RCC_SEP}\n`),
);
check('空的用户发言不占一行', mod.sessionUserText([{ userText: '  ' }, { userText: '有' }]).text === '有');
check(
  '★ 只裁"太长的那一条"，短的发言一个字不动',
  (() => {
    const r = mod.sessionUserText(rccS1Turns);
    return r.truncated === false && r.cutCount === 0;
  })(),
);

// ---- 第二层：整场截断（Kimi 那边"只保留 12 句"的那一层）----
// 用户 2026-09-17 拍板：「整场截断就保留**前面 12 条**啊，不是前 6 条后 6 条」。
const manyTurns = Array.from({ length: 20 }, (_, i) => ({ userText: `第${i + 1}句` }));
const cut20 = mod.sessionUserText(manyTurns, mod.DEFAULT_CUT);
check(
  '★ 整场截断：20 句只留【前面 12 句】，中间插一句显式标记',
  cut20.droppedTurns === 8 && cut20.text.includes(mod.RCC_TRUNCATED),
  `dropped=${cut20.droppedTurns}`,
);
check(
  '★ 标记就是个光秃秃的 [TL;DR]（"此处省略 N 句"算得出来，不往上下文里塞）',
  cut20.text.split(`\n${mod.RCC_SEP}\n`).includes(mod.RCC_TRUNCATED) && !cut20.text.includes('省略'),
);
check(
  '留下的是第 1..12 句，第 13 句往后全砍（不是前 6 后 6）',
  (() => {
    const segs = cut20.text.split(`\n${mod.RCC_SEP}\n`);
    const kept = segs.filter((l) => l !== mod.RCC_TRUNCATED);
    return kept.length === 12 && kept[0] === '第1句' && kept[11] === '第12句' && segs[12] === mod.RCC_TRUNCATED;
  })(),
  cut20.text.split(`\n${mod.RCC_SEP}\n`).length + ' 段',
);
check('★ 整场被裁也算"这场被裁过"（补丁的判据靠它）', cut20.truncated === true);
check(
  '句数没超上限（正好 12 句）时不动',
  mod.sessionUserText(manyTurns.slice(0, 12), mod.DEFAULT_CUT).droppedTurns === 0,
);
// 尾 N 句仍然**可配**：默认 0，但配上了就照"头 + 尾"留（老行为还在，只是不再是默认）。
check(
  '尾 N 句配上时两头都留（头 6 + 尾 6 仍然可用）',
  (() => {
    const r = mod.sessionUserText(manyTurns, { head: 60, tail: 40, headTurns: 6, tailTurns: 6 });
    const kept = r.text.split(`\n${mod.RCC_SEP}\n`).filter((l) => l !== mod.RCC_TRUNCATED);
    return r.droppedTurns === 8 && kept.length === 12 && kept[0] === '第1句' && kept[11] === '第20句';
  })(),
);
check(
  '两层都关掉时什么都不裁（取完整原文）',
  (() => {
    const r = mod.sessionUserText(manyTurns, mod.NO_CUT);
    return r.truncated === false && r.text.split(`\n${mod.RCC_SEP}\n`).length === 20;
  })(),
);
check(
  '标题回退成"这一场的第一句"（sessions.title 还没接）',
  mod.sessionTitle({ session: 'x', title: null, startedAt: null, inRcc: false, rccTruncated: false }, rccS3Turns).startsWith('机票价格比较'),
);
check(
  '有真标题时用真标题',
  mod.sessionTitle({ session: 'x', title: 'Claude误会', startedAt: null, inRcc: false, rccTruncated: false }, []) === 'Claude误会',
);

// 第四场：20 句短发言（都不会被单条裁），用来验"整场截断"与"只补被砍掉的原话"。
// 整场只留**前 12 句**，所以看得见＝第 1..12 句：
//   第 1 句（开头甲）与第 12 句（可见丁）埋词 → 命中也不该补；
//   第 16 句（中段乙）与第 18 句（尾段戊）落在被砍掉的区段里 → 只有它们的命中才该补。
//   其余 17 句都带同一个词（普通）→ 用来说明"泛词单独命中不算数"。
fsm.writeFileSync(
  join(rccH, '.dsh-mem', 'raw', 'turns', 'rcc-s4.jsonl'),
  Array.from({ length: 20 }, (_, i) =>
    rccLine({
      session: 'rcc-s4',
      turn: i + 1,
      at: new Date(Date.parse('2026-09-13T01:00:00.000Z') + i * 60000).toISOString(),
      cwd: null,
      space: 'chat',
      user:
        i === 0
          ? '开头甲在这里'
          : i === 11
            ? '可见丁也在这里'
            : i === 15
              ? '中段乙藏在这里'
              : i === 17
                ? '尾段戊也在此'
                : `普通第${i + 1}句`,
      assistant: '回',
      tools: [],
    }),
  ).join(''),
  'utf8',
);
mod.rebuildTurns(rccDb, rccH); // 第四场要进索引才能被选中

const rccCut = { ...mod.DEFAULT_CUT };

// ---- 拼 RCC ----
const rccBuilt = mod.buildRcc(rccDb, { sessions: 4, ...rccCut, maxChars: 100000 });
check('覆盖最近 N 场', rccBuilt.covered.length === 4, JSON.stringify(rccBuilt.covered));
check(
  '★ 只有"真被裁过"的场才记 truncated（s3 单条被裁、s4 整场被裁）',
  rccBuilt.truncated.includes('rcc-s3') && rccBuilt.truncated.includes('rcc-s4') && rccBuilt.truncated.length === 2,
  JSON.stringify(rccBuilt.truncated),
);
check('正文带场号', rccBuilt.text.includes('1. ') && rccBuilt.text.includes('3. '));
check('正文逐字带用户发言（不是摘要）', rccBuilt.text.includes('机票价格比较'));
check('没超总量预算时不丢场', rccBuilt.dropped.length === 0);
const rccTight = mod.buildRcc(rccDb, { sessions: 4, ...rccCut, maxChars: 200 });
check(
  '★ 总量超预算从【最旧】的场开始丢（最旧的最短 → 证明按年龄而不是按大小）',
  rccTight.dropped[0] === 'rcc-s1' && rccTight.covered[rccTight.covered.length - 1] === 'rcc-s4',
  JSON.stringify([rccTight.dropped, rccTight.covered]),
);
const rccEmptyDb = mod.openIndex(join(HOME, 'rcc-empty.db'));
check('一场都没有时返回 null（不产生空消息）', mod.buildRcc(rccEmptyDb, { sessions: 3, head: 60, tail: 40, headTurns: 6, tailTurns: 6, maxChars: 100 }) === null);
mod.closeIndex(rccEmptyDb);

// ---- 补丁链路 ----
// 模拟宿主：把"哪些场进了 RCC / 哪些被裁"回写（§5.8 要求状态可查，不能每轮重算）
mod.setRccState(rccDb, rccBuilt.covered, { inRcc: true });
mod.setRccState(rccDb, rccBuilt.truncated, { truncated: true });
const rccCand = mod.patchCandidates(rccDb, '机票价格', { k: 2, maxChars: 1000, cut: rccCut });
check('命中【且被裁过】的那一轮成为补丁候选', rccCand.length === 1 && rccCand[0].key === 'rcc-s3#1', JSON.stringify(rccCand.map((c) => c.key)));
check(
  '★ 补丁补的是【那一轮】的完整原话（正文里一个裁断标记都没有）',
  rccCand[0].text.includes('结尾标记') &&
    !rccCand[0].text.includes(`\n${mod.RCC_TRUNCATED}\n`) &&
    rccCand[0].text.includes('这一轮'),
  `${rccCand[0].text.length} 字符`,
);
// ★ 补丁被预算逼到上限时，兜底也必须是【掐中段】—— 踩过：一度传了 tail=0 把尾巴全砍光
const rccPatchTight = mod.patchCandidates(rccDb, '机票价格', { k: 1, maxChars: 200, cut: rccCut });
check(
  '★ 补丁的兜底也是掐中段（头尾都留），不是只留头',
  rccPatchTight.length === 1 &&
    rccPatchTight[0].text.includes(`\n${mod.RCC_TRUNCATED}\n`) &&
    rccPatchTight[0].text.includes('结尾标记'),
  `${rccPatchTight[0]?.text.length ?? 0} 字符`,
);
check(
  '补丁带场号 + 轮次（否则模型认不出补的是哪一场的哪一句）',
  rccCand[0].label.startsWith('3. ') &&
    rccCand[0].label.includes('第1轮') &&
    rccCand[0].text.includes(rccCand[0].label),
);
check(
  '★ 命中但【没被裁】的场不产生补丁（它已经完整在上下文里）',
  mod.patchCandidates(rccDb, '记忆插件', { k: 2, maxChars: 1000, cut: rccCut }).length === 0,
);

// ★★ 用户给的判据是「如果**原话在被砍掉的对话里面**就注入一下」——
//    所以"这场被裁过"不够：命中的**那一轮**必须真的被砍掉才算数。
check(
  '★ 命中【被整场砍掉】的那句 → 补',
  (() => {
    const c = mod.patchCandidates(rccDb, '中段乙', { k: 1, maxChars: 1000, cut: rccCut });
    return c.length === 1 && c[0].key === 'rcc-s4#16';
  })(),
);
check(
  '★ 补的**只是那一轮**，同场别的轮次一个字都不带（用户 09-17：「不是补整场对话」）',
  (() => {
    const c = mod.patchCandidates(rccDb, '中段乙', { k: 1, maxChars: 1000, cut: rccCut });
    const t = c[0]?.text ?? '';
    const lines = t.split('\n');
    return (
      lines[lines.length - 1] === '中段乙藏在这里' &&
      t.includes('第16轮') &&
      !t.includes('可见丁') &&
      !t.includes('尾段戊') &&
      !t.includes('普通')
    );
  })(),
);
check(
  '★ 同一场命中两轮 → 两条补丁（去重键是【轮】不是场）',
  (() => {
    const c = mod.patchCandidates(rccDb, '中段乙尾段戊', { k: 2, maxChars: 1000, cut: rccCut });
    return c.map((x) => x.key).sort().join(',') === 'rcc-s4#16,rcc-s4#18';
  })(),
  (() => {
    const c = mod.patchCandidates(rccDb, '中段乙尾段戊', { k: 2, maxChars: 1000, cut: rccCut });
    return JSON.stringify(c.map((x) => x.key));
  })(),
);
check(
  '★ 命中【头 12 句里看得见】的那句 → 不补（补了是白花预算）',
  mod.patchCandidates(rccDb, '开头甲', { k: 1, maxChars: 1000, cut: rccCut }).length === 0,
);
check(
  '★ 头 12 句的最后一句（第 12 句）也看得见 → 不补',
  mod.patchCandidates(rccDb, '可见丁', { k: 1, maxChars: 1000, cut: rccCut }).length === 0,
);

// ★★ 辨识度门槛（2026-09-17）：泛词单独命中不算数 ——
//    真实库上 `记忆` 覆盖 24.7% 的轮次，一句"宝宝你有记忆了吗"曾一次拉进两整场对话。
check(
  '★ 整句话都是泛词（`普通` 覆盖 16/21 轮）→ 一条都不补',
  mod.patchCandidates(rccDb, '普通', { k: 2, maxChars: 1000, cut: rccCut }).length === 0,
);
check(
  '泛词 + 一个实词就照常补（门槛只挡"纯泛词"）',
  mod.patchCandidates(rccDb, '普通中段乙', { k: 1, maxChars: 1000, cut: rccCut }).length === 1,
);
check(
  'distinctiveTokens：泛词被剔除，实词留下（bigram 粒度）',
  (() => {
    const turns = mod.listTurns(rccDb).filter((t) => t.session === 'rcc-s4');
    const d = mod.distinctiveTokens('普通中段乙', turns);
    return d.includes('中段') && d.includes('段乙') && !d.includes('普通');
  })(),
  (() => {
    const turns = mod.listTurns(rccDb).filter((t) => t.session === 'rcc-s4');
    return JSON.stringify(mod.distinctiveTokens('普通中段乙', turns));
  })(),
);

// 把 s1 移出 RCC：它命中也不该被补 —— 补丁只能补 RCC 覆盖范围内的场
mod.setRccState(rccDb, ['rcc-s1'], { inRcc: false });
check(
  '★ 不在 RCC 覆盖范围内的场不补（哪怕命中）',
  mod.patchCandidates(rccDb, '今天天气', { k: 2, maxChars: 1000, cut: rccCut }).length === 0,
);
mod.setRccState(rccDb, ['rcc-s1'], { inRcc: true });
check('k 是上限', mod.patchCandidates(rccDb, '机票价格', { k: 1, maxChars: 1000, cut: rccCut }).length <= 1);
check('空查询不给候选', mod.patchCandidates(rccDb, '   ', { k: 2, maxChars: 1000, cut: rccCut }).length === 0);

// ---- BM25 打分器（与 §13.3 同规格）----
const rccRanked = mod.rankTurns('机票价格', mod.listTurns(rccDb), 3);
check('BM25 把命中的那轮排第一', rccRanked.length > 0 && rccRanked[0].turn.session === 'rcc-s3', JSON.stringify(rccRanked.map((r) => [r.turn.session, r.score.toFixed(2)])));
check('不相关的轮次不进榜（分数为 0 直接丢）', mod.rankTurns('完全不存在的词xyz', mod.listTurns(rccDb), 3).length === 0);
check('k<=0 时返回空', mod.rankTurns('机票价格', mod.listTurns(rccDb), 0).length === 0);

// ★ 没有轮次的会话行会被 rebuildTurns 清掉 —— 否则 RCC 会多出一个空场
mod.ensureSession(rccDb, 'ghost-session');
check('先确保空壳会话行存在', mod.getSession(rccDb, 'ghost-session') !== null);
mod.rebuildTurns(rccDb, rccH);
check('★ 空壳会话行被清掉（素材没了，会话行也该没）', mod.getSession(rccDb, 'ghost-session') === null);

// ★★ 折叠重复分支：手滑点出来的「分叉会话」，用户发言就是父会话的前缀。
//    DSH **不删会话日志**（界面上删了、磁盘上还在），所以只能由我们这侧折叠。
const foldItems = [
  { id: 'parent', lines: ['a', 'b', 'c', 'd'] },
  { id: 'fork1', lines: ['a', 'b'] },
  { id: 'fork2', lines: ['a', 'b'] },
  { id: 'other', lines: ['x', 'y'] },
];
const foldedRes = mod.foldContained(foldItems, (i) => i.lines, (i) => i.id);
check(
  '★ 被父会话包含的分支被折叠掉（等长的两条也只留一条）',
  foldedRes.folded.join(',') === 'fork1,fork2',
  JSON.stringify(foldedRes.folded),
);
check(
  '有独有内容 / 不相关的场不动',
  foldedRes.kept.map((i) => i.id).join(',') === 'parent,other',
  JSON.stringify(foldedRes.kept.map((i) => i.id)),
);
check(
  '前缀判定本身（方向不能反）',
  mod.isPrefixOf(['a'], ['a', 'b']) && !mod.isPrefixOf(['b'], ['a', 'b']) && !mod.isPrefixOf(['a', 'b'], ['a']),
);
check(
  '空序列不参与折叠',
  (() => {
    const r = mod.foldContained([{ id: 'e', lines: [] }, { id: 'r', lines: ['a'] }], (i) => i.lines, (i) => i.id);
    return r.folded.length === 0 && r.kept.length === 2;
  })(),
);

// 集成：buildRcc 里这一步真的生效
const foldHome = join(HOME, 'fold-home');
fsm.mkdirSync(join(foldHome, '.dsh-mem', 'raw', 'turns'), { recursive: true });
const foldLines = (session, at, users) =>
  users
    .map((u, i) =>
      rccLine({
        session,
        turn: i + 1,
        at: new Date(Date.parse(at) + i * 60000).toISOString(),
        cwd: null,
        space: 'chat',
        user: u,
        assistant: '回',
        tools: [],
      }),
    )
    .join('');
fsm.writeFileSync(
  join(foldHome, '.dsh-mem', 'raw', 'turns', 'fold-p.jsonl'),
  foldLines('fold-p', '2026-09-16T01:00:00.000Z', ['甲', '乙', '丙', '丁', '戊', '己']),
  'utf8',
);
fsm.writeFileSync(
  join(foldHome, '.dsh-mem', 'raw', 'turns', 'fold-f.jsonl'),
  foldLines('fold-f', '2026-09-16T00:00:00.000Z', ['甲', '乙', '丙']),
  'utf8',
);
const foldDb = mod.openIndex(join(foldHome, 'index.db'));
mod.rebuildTurns(foldDb, foldHome);
const foldBuilt = mod.buildRcc(foldDb, { sessions: 10, ...rccCut, maxChars: 100000 });
check(
  '★ buildRcc 会折叠被包含的分支（只留父会话，且 folded 报出来）',
  foldBuilt.covered.length === 1 && foldBuilt.covered[0] === 'fold-p' && foldBuilt.folded.join(',') === 'fold-f',
  JSON.stringify([foldBuilt.covered, foldBuilt.folded]),
);
mod.closeIndex(foldDb);
mod.closeIndex(rccDb);


disposeRoutes();
check('路由注销不抛错', true);

console.log('\n=== 9. 卸载路径（effect disposer）===');
check('apply 注册了 effect', effects.length > 0, `${effects.length} 个`);
for (const d of effects) {
  try {
    d?.();
  } catch (e) {
    check('disposer 抛异常', false, e.message);
  }
}
check('disposer 执行完毕未抛错', true);
// 卸载后索引库应已关闭 —— 能删掉就说明没有残留句柄
let cleaned = false;
try {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  cleaned = true;
} catch (e) {
  console.log(`  ⚠️  清理临时目录失败（非产品问题）: ${e.code}`);
}
check('卸载后可清理数据目录', cleaned);

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
