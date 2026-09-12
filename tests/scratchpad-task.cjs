const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
class Node {
  value = ''; disabled = false; hidden = false; open = false; handlers = {};
  addEventListener(type, fn) { this.handlers[type] = fn; }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  focus() {}
}
const nodes = new Map();
const lists = [{ id: 'active', name: '工作', tasks: [] }, { id: 'stored', name: '旧事', archived: true, tasks: [] }];
let menuOptions;
const sandbox = { exports: {}, document: {
  getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, querySelector: () => null,
}, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  window: { setTimeout: fn => fn() }, require: id => id.endsWith('/menu')
    ? { Menu: { new: async opts => { menuOptions = opts; return { popup: async () => {} }; } } }
    : { LogicalPosition: class {} },
};
vm.runInNewContext(compile(fs.readFileSync('src/scratchpad-task.ts', 'utf8')), sandbox);
const { taskFromSelection, taskDestinationError, ScratchpadTaskComposer } = sandbox.exports;
assert.equal(taskFromSelection('  收拾书桌\n\n再整理资料  '), '收拾书桌 再整理资料');
assert.equal(taskFromSelection('<b>🌱</b>'), '<b>🌱</b>');
assert.ok(taskDestinationError(lists, 'active', ' '));
assert.ok(taskDestinationError(lists, 'active', '字'.repeat(201)));
assert.equal(taskDestinationError(lists, 'active', '字'.repeat(200)), '');
assert.ok(taskDestinationError(lists, 'stored', '任务'));
assert.ok(taskDestinationError([], 'gone', '任务'));
assert.ok(taskDestinationError([{ id: 'full', tasks: Array(100) }], 'full', '任务'));

(async () => {
  const input = new Node();
  input.value = '保留这行\n整理书桌\n也保留末尾';
  input.selectionStart = 5; input.selectionEnd = 9;
  input.getBoundingClientRect = () => ({ left: 0, top: 0 });
  let calls = 0, finish;
  const composer = new ScratchpadTaskComposer(input, () => lists,
    async () => { calls++; await new Promise(resolve => finish = resolve); }, () => {});
  input.handlers.contextmenu({ preventDefault() {}, clientX: 20, clientY: 20 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(menuOptions.items.some(item => item.item === 'Copy'));
  menuOptions.items[0].action();
  assert.equal(nodes.get('scratchpad-task-content').value, '整理书桌');
  assert.equal(nodes.get('scratchpad-task-list').children.length, 1);
  const form = nodes.get('scratchpad-task-form');
  form.handlers.submit({ preventDefault() {} });
  form.handlers.submit({ preventDefault() {} });
  assert.equal(calls, 1);
  finish(); await composer.flush();
  assert.equal(nodes.get('scratchpad-task-dialog').open, false);
  assert.equal(input.value, '保留这行\n整理书桌\n也保留末尾');
  composer.add = async () => { throw new Error('保存失败'); };
  composer.open(); form.handlers.submit({ preventDefault() {} }); await assert.rejects(composer.flush());
  assert.equal(nodes.get('scratchpad-task-dialog').open, true);
  assert.match(nodes.get('scratchpad-task-error').textContent, /保存失败|未能加入/);
  assert.equal(nodes.get('scratchpad-task-save').disabled, false);

  const main = fs.readFileSync('src/main.ts', 'utf8');
  const fn = main.slice(main.indexOf('async function addScratchpadTask('), main.indexOf('type ReorderPreviewKind'));
  const previous = [{ ...lists[0], dailyReset: true, lastResetDate: '2026-09-11' }, lists[1]];
  let fail = false;
  const context = { checklists: previous, scratchpadEditor: { flush: async () => {} }, taskDestinationError,
    crypto: { randomUUID: () => 'new-task-id' }, invoke: async () => { if (fail) throw Error('save failed'); }, renderChecklists() {}, showToast() {} };
  vm.createContext(context); vm.runInContext(compile(fn), context);
  await context.addScratchpadTask('active', '整理书桌');
  assert.equal(context.checklists[0].tasks[0].completed, false);
  assert.equal(context.checklists[0].dailyReset, true);
  assert.equal(context.checklists[1], previous[1]);
  const saved = context.checklists; fail = true;
  await assert.rejects(context.addScratchpadTask('active', '另一个任务'));
  assert.equal(context.checklists, saved);
  console.log('PASS: selection snapshot, native edit menu, one-task submit, duplicate prevention, source preservation, validation, retry and save rollback');
})();
