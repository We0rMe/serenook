// Exercise the production autosave controller without a browser or a user's records.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const source = ts.transpileModule(fs.readFileSync('src/scratchpad.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const timers = new Map();
let timerId = 0;
const locationSandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/text-location.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, locationSandbox);
const cache = new Map();
const frames = [];
const sandbox = {
  exports: {}, require: () => locationSandbox.exports,
  requestAnimationFrame: (fn) => frames.push(fn),
  localStorage: { getItem: (key) => cache.get(key), setItem: (key, value) => cache.set(key, value) },
  setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
};
vm.runInNewContext(source, sandbox);
const { ScratchpadEditor } = sandbox.exports;
class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; listeners = new Map();
  selectionStart = 0; selectionEnd = 0; scrollTop = 0;
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  fire(name) { this.listeners.get(name)?.(); }
}
function fixture(invoke) {
  const input = new Element(), status = new Element(), retry = new Element();
  return { input, status, retry, editor: new ScratchpadEditor(input, status, retry, invoke) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  const writes = [];
  let fail = false, release;
  const f = fixture(async (command, args) => {
    if (command === 'load_scratchpad') return { content: '原有文字\n' };
    if (fail) throw Error('disk unavailable');
    writes.push(args.page.content);
    if (args.page.content === '第一笔') await new Promise((resolve) => { release = resolve; });
  });
  await f.editor.initialize();
  assert.equal(f.input.value, '原有文字\n');
  await f.editor.flush();
  assert.equal(writes.length, 0);
  f.input.value = '第一笔';
  const first = f.editor.flush();
  await tick();
  f.input.value = '  新的一笔🌱\n保留换行\n';
  const second = f.editor.flush();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ['第一笔', '  新的一笔🌱\n保留换行\n']);
  assert.equal(f.status.textContent, '已保存到本地');
  f.input.value = '';
  await f.editor.flush();
  assert.equal(writes.at(-1), '');
  fail = true;
  f.input.value = '失败后仍在';
  await assert.rejects(f.editor.flush());
  assert.equal(f.input.value, '失败后仍在');
  assert.equal(f.retry.hidden, false);
  fail = false;
  await f.editor.flush();
  assert.equal(writes.at(-1), '失败后仍在');
  assert.equal(f.retry.hidden, true);
  f.input.fire('compositionstart');
  f.input.value = '拼音输入中';
  f.input.fire('input');
  assert.equal(timers.size, 0);
  f.input.fire('compositionend');
  assert.equal(timers.size, 1);
  const callback = [...timers.values()][0];
  timers.clear(); callback(); await tick();
  assert.equal(writes.at(-1), '拼音输入中');
  f.input.value = '离开时保存';
  f.input.fire('input'); f.input.fire('blur'); await tick();
  assert.equal(timers.size, 0);
  assert.equal(writes.at(-1), '离开时保存');
  let saves = 0;
  const damaged = fixture(async (command) => {
    if (command === 'load_scratchpad') throw Error('damaged');
    saves++;
  });
  await damaged.editor.initialize();
  assert.equal(damaged.input.disabled, true);
  await damaged.editor.flush();
  assert.equal(saves, 0);
  assert.equal(damaged.retry.hidden, false);
  f.input.setSelectionRange(1, 3); f.input.scrollTop = 240;
  const before = writes.length;
  await f.editor.flush();
  assert.equal(writes.length, before, 'View changes must not cause native writes');
  const restored = fixture(async () => ({ content: '离开时保存' }));
  await restored.editor.initialize(); restored.editor.restoreView();
  assert.equal(restored.input.selectionStart, 1);
  assert.equal(restored.input.selectionEnd, 3);
  assert.equal(restored.input.scrollTop, 240);
  frames.splice(0).forEach(fn => fn());
  const changed = fixture(async () => ({ content: '恢复备份后的不同内容' }));
  await changed.editor.initialize(); changed.editor.restoreView();
  assert.equal(changed.input.scrollTop, 0, 'Stale view state must not apply to different content');
  console.log('PASS: autosave, failure protection, IME, view-only persistence, position restoration, stale-position rejection');
})().catch((error) => { console.error(error); process.exitCode = 1; });
