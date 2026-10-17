// Exercise the real editor/save functions with isolated state, never live user data.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const source = ts.createSourceFile('main.ts', fs.readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const names = ['openEditor', 'closeEditor', 'saveFromForm', 'updateNewShortcutSleepButton', 'selectedShortcutKind'];
const functions = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(functions.length, names.length);
const code = ts.transpileModule(functions.map(n => n.getText(source)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const clone = value => JSON.parse(JSON.stringify(value));
function field() {
  const classes = new Set();
  return { value: '', hidden: false, textContent: '', attrs: {},
    focus() { this.focused = true; },
    setAttribute(name, value) { this.attrs[name] = value; },
    querySelector: () => null,
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, remove: name => classes.delete(name) },
  };
}
const original = [{ id: 'existing', name: '原有入口', target: 'C:\\original.exe', kind: 'local', sleeping: true, wakeDays: [1, 3], icon: 'app' }];
const kindSelector = field();
const radios = ['local', 'web', 'folder'].map(value => ({ ...field(), value, checked: value === 'local' }));
const writes = [];
let selectedKind = 'local';
let serial = 0;
let failSave = false;
let revealed = 0;
const ctx = {
  shortcuts: clone(original), droppedEntryDraft: false, newShortcutSleeping: false, sleepExpanded: false,
  shortcutDrop: { cancel() {} },
  form: {
    reset() { radios.forEach(radio => { radio.checked = radio.value === 'local'; }); },
    querySelector(selector) {
      if (selector === '.shortcut-kind-selector') return kindSelector;
      if (selector.endsWith(':checked')) return radios.find(radio => radio.checked);
      const value = selector.match(/value="([^"]+)"/)?.[1];
      const radio = radios.find(radio => radio.value === value);
      if (!radio) return null;
      return { set checked(on) { radios.forEach(other => { other.checked = on && other === radio; }); } };
    },
  },
  formError: field(), idInput: field(), nameInput: field(), targetInput: field(), dialogTitle: field(),
  sleepButton: field(), sleepButtonLabel: field(), deleteButton: field(), browseButton: field(),
  editButton: field(), shortcutsModuleToggle: field(), element: () => field(),
  dialog: { open: false, showModal() { this.open = true; }, close() { this.open = false; } },
  window: { setTimeout: callback => callback() }, ICONS: { sun: '', moon: '' },
  shortcutKind: entry => entry.kind ?? 'local', setTargetMode: kind => { selectedKind = kind; },
  isWorkspaceModuleActive: () => true,
  crypto: { randomUUID: () => `new-${++serial}` }, inferIcon: () => 'app',
  duplicateLocalEntry: (target, kind) => ctx.shortcuts.some(entry => entry.target === target && entry.kind === kind),
  persist: async () => { if (failSave) throw Error('保存失败'); writes.push(clone(ctx.shortcuts)); },
  revealWorkspaceModule: async id => { assert.equal(id, 'shortcuts'); revealed++; return true; },
  render() {}, hydrateAppIcons: async () => {}, refreshRunningApps: async () => {}, showToast() {},
  errorMessage: error => error.message,
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

(async () => {
  const draft = { name: '文档', target: 'C:\\documents', kind: 'folder', sleeping: true };
  ctx.openEditor(undefined, draft);
  assert.equal(ctx.dialogTitle.textContent, '添加一个入口');
  assert.equal(ctx.idInput.value, '');
  assert.equal(ctx.nameInput.value, draft.name);
  assert.equal(ctx.targetInput.value, draft.target);
  assert.equal(selectedKind, 'folder');
  assert.equal(ctx.newShortcutSleeping, true);
  assert.equal(ctx.sleepButton.attrs['aria-pressed'], 'true');
  assert.equal(ctx.deleteButton.hidden, true);
  assert.equal(ctx.nameInput.focused, true);
  assert.equal(writes.length, 0);
  ctx.closeEditor();
  assert.equal(ctx.droppedEntryDraft, false);
  assert.deepEqual(clone(ctx.shortcuts), original);
  assert.equal(writes.length, 0); // Neither prefill nor cancellation writes anything.

  ctx.openEditor(undefined, draft);
  ctx.nameInput.value = '  整理资料  ';
  await ctx.saveFromForm();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0][0], original[0]);
  assert.equal(writes[0][1].name, '整理资料');
  assert.equal(writes[0][1].target, draft.target);
  assert.equal(writes[0][1].kind, 'folder');
  assert.equal(writes[0][1].sleeping, true);
  assert.equal(ctx.sleepExpanded, true);
  assert.equal(ctx.dialog.open, false);
  assert.equal(revealed, 1);

  ctx.openEditor(undefined, draft);
  await ctx.saveFromForm();
  assert.equal(writes.length, 1); // Recheck duplicates at save, not only when dropped.
  assert.equal(ctx.dialog.open, true);
  assert.match(ctx.formError.textContent, /已在常用入口/);
  ctx.closeEditor();

  const beforeFailure = clone(ctx.shortcuts);
  ctx.openEditor(undefined, { ...draft, target: 'C:\\report.pdf', kind: 'local', sleeping: false });
  failSave = true;
  await ctx.saveFromForm();
  assert.deepEqual(clone(ctx.shortcuts), beforeFailure);
  assert.equal(ctx.dialog.open, true);
  assert.equal(ctx.droppedEntryDraft, true);
  assert.equal(ctx.formError.textContent, '保存失败');
  failSave = false;
  await ctx.saveFromForm();
  assert.equal(writes.length, 2);
  assert.equal(ctx.shortcuts.at(-1).sleeping, false);

  ctx.openEditor(ctx.shortcuts[0]);
  ctx.nameInput.value = '修改名称';
  await ctx.saveFromForm();
  assert.deepEqual(clone(ctx.shortcuts[0]), { ...original[0], name: '修改名称' });
  assert.equal(ctx.shortcuts.length, 3);
  assert.equal(revealed, 2); // Normal edits retain their previous behavior.

  // The removed option must not turn imported application IDs into local paths.
  const imported = { id: 'imported', name: '系统应用', target: 'Example.Package!App', kind: 'app', icon: 'app', sleeping: true, wakeDays: [2, 4] };
  ctx.shortcuts.push(imported);
  ctx.openEditor(imported);
  assert.equal(kindSelector.hidden, true);
  assert.equal(kindSelector.disabled, true);
  assert.equal(ctx.selectedShortcutKind(), 'app');
  ctx.nameInput.value = '系统应用改名';
  await ctx.saveFromForm();
  assert.deepEqual(clone(ctx.shortcuts.at(-1)), { ...imported, name: '系统应用改名' });

  ctx.openEditor();
  assert.equal(kindSelector.hidden, false);
  assert.equal(kindSelector.disabled, false);
  assert.equal(ctx.selectedShortcutKind(), 'local');
  assert.equal(ctx.nameInput.value, '');
  assert.equal(ctx.targetInput.value, '');
  assert.equal(ctx.newShortcutSleeping, false);
  assert.equal(ctx.droppedEntryDraft, false);
  ctx.closeEditor();
  console.log('PASS: drop prefill, cancel without saving, sleep destination, duplicate recheck, save rollback/retry, imported application identity preservation, manual-add reset');
})().catch(error => { console.error(error); process.exitCode = 1; });
