// Exercise production quick-add state and keyboard handling without touching user data.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleContext = { exports: {} };
vm.createContext(moduleContext);
vm.runInContext(compile(fs.readFileSync('src/checklist-composer.ts', 'utf8')), moduleContext);
const { ChecklistComposer } = moduleContext.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { this.events[type] = listener; }
  fire(type, values = {}) {
    const event = { target: this, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    this.events[type]?.(event);
    return event;
  }
  requestSubmit() { this.submissions = (this.submissions || 0) + 1; this.fire('submit'); }
}
const parsed = ts.createSourceFile('main.ts', fs.readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['createTaskComposer', 'addChecklistTask', 'persistChecklistChanges'];
const selected = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(selected.length, names.length);
let saveFails = false;
let id = 0;
const ctx = {
  checklistComposer: new ChecklistComposer(), MAX_TASK_CONTENT_LENGTH: 200,
  checklists: [], focusedChecklistId: null, checklistFocusDialog: {},
  document: { createElement: tag => new Element(tag), body: {} },
  icon: name => ({ icon: name }), crypto: { randomUUID: () => `new-${++id}` }, CSS: { escape: text => text },
  renderChecklists() {}, focusTaskComposer() {}, errorMessage: error => error.message,
  activeChecklistRoot: () => ({ querySelector: () => ({ focus() {} }) }),
  showToast() {}, invoke: async () => { if (saveFails) throw new Error('save failed'); },
};
ctx.document.activeElement = ctx.document.body;
vm.createContext(ctx);
vm.runInContext(compile(selected.map(n => n.getText(parsed)).join('\n')), ctx);
const list = () => ({ id: 'a', name: '清单', dailyReset: true, lastResetDate: '2026-10-13',
  tasks: [{ id: 'old', content: '原有任务', important: true, completed: true, shortcutId: 'entry' }] });

(async () => {
  const model = new ChecklistComposer();
  assert.equal(await model.submit('a', () => { throw new Error('blank should not save'); }), false);
  model.setOpen('a', true);
  model.update('a', { content: '  新任务  ', important: true });
  model.setOpen('a', false);
  assert.equal(model.get('a').content, '  新任务  ');
  model.setOpen('a', true);
  const gate = deferred(); const order = [];
  const first = model.submit('a', async (text, important) => {
    order.push('a'); assert.equal(text, '新任务'); assert.equal(important, true); return gate.promise;
  });
  assert.equal(model.submit('a', () => { throw new Error('duplicate'); }), first);
  model.update('a', { content: 'must not replace an in-flight draft' });
  assert.equal(model.get('a').content, '  新任务  ');
  model.update('b', { content: '另一张清单' });
  const second = model.submit('b', async () => { order.push('b'); return true; });
  let flushed = false; const flushing = model.flush().then(() => { flushed = true; });
  await tick(); assert.deepEqual(order, ['a']); assert.equal(flushed, false);
  gate.resolve(true); await Promise.all([first, second, flushing]);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(model.get('a').open, true); assert.equal(model.get('a').content, '');
  assert.equal(model.get('a').important, false); assert.equal(model.get('a').saving, false);
  model.update('a', { content: '失败后仍保留', important: true });
  assert.equal(await model.submit('a', async () => false), false);
  assert.equal(model.get('a').content, '失败后仍保留');
  await assert.rejects(model.submit('a', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(model.get('a').important, true); assert.equal(model.get('a').saving, false);
  assert.equal(await model.submit('a', async () => true), true);

  ctx.checklists = [list()];
  const original = JSON.stringify(ctx.checklists);
  let shell = ctx.createTaskComposer(ctx.checklists[0]);
  assert.equal(shell.children[0].hidden, false); assert.equal(shell.children[1].hidden, true);
  shell.children[0].fire('click');
  shell = ctx.createTaskComposer(ctx.checklists[0]);
  const form = shell.children[1]; const [input, important, add] = form.children;
  assert.equal(shell.children[0].hidden, true); assert.equal(form.hidden, false);
  assert.equal(add.disabled, true);
  input.value = '  中文任务  '; input.fire('input'); important.fire('click');
  assert.equal(add.disabled, false); assert.equal(important.attributes['aria-pressed'], 'true');
  input.fire('compositionstart');
  form.fire('keydown', { key: 'Enter', target: input, isComposing: true });
  form.fire('submit');
  assert.equal(form.submissions, undefined); assert.equal(ctx.checklists[0].tasks.length, 1);
  input.fire('compositionend');
  form.fire('keydown', { key: 'Enter', target: input, keyCode: 229 });
  assert.equal(form.submissions, undefined);
  const escape = form.fire('keydown', { key: 'Escape', target: input });
  assert.equal(escape.prevented, true); assert.equal(escape.stopped, true);
  assert.equal(ctx.checklistComposer.get('a').content, '  中文任务  ');
  ctx.checklistComposer.setOpen('a', true);
  const submit = form.fire('keydown', { key: 'Enter', target: input });
  assert.equal(submit.prevented, true);
  form.fire('submit'); // repeated click / Enter cannot add twice
  await ctx.checklistComposer.flush(); await tick();
  assert.equal(ctx.checklists[0].tasks.length, 2);
  assert.equal(JSON.stringify(ctx.checklists[0].tasks[0]), JSON.stringify(JSON.parse(original)[0].tasks[0]));
  assert.equal(ctx.checklists[0].tasks[1].content, '中文任务');
  assert.equal(ctx.checklists[0].tasks[1].important, true);
  assert.equal(ctx.checklists[0].lastResetDate, '2026-10-13');
  assert.equal(ctx.checklistComposer.get('a').content, '');

  saveFails = true;
  const beforeFailure = JSON.stringify(ctx.checklists);
  ctx.checklistComposer.update('a', { content: '等待重试' });
  assert.equal(await ctx.checklistComposer.submit('a', (text, marked) => ctx.addChecklistTask('a', text, marked)), false);
  assert.equal(JSON.stringify(ctx.checklists), beforeFailure);
  assert.equal(ctx.checklistComposer.get('a').content, '等待重试');
  saveFails = false;
  assert.equal(await ctx.addChecklistTask('missing', '拒绝', false), false);
  ctx.checklists[0].archived = true;
  assert.equal(await ctx.addChecklistTask('a', '拒绝', false), false);
  ctx.checklists[0].archived = false;
  ctx.checklists[0].tasks = Array.from({ length: 100 }, (_, i) => ({ id: String(i), content: '任务' }));
  assert.equal(await ctx.addChecklistTask('a', '第101项', false), false);
  assert.equal(ctx.checklists[0].tasks.length, 100);
  console.log('PASS: quick-add drafts, single-flight/serial writes, retry/rollback, Enter/Esc/IME, existing data and archive/capacity guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
