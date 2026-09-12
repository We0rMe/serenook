const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const source = fs.readFileSync('src/main.ts', 'utf8');
const implementation = source.slice(source.indexOf('function isMissingTarget('), source.indexOf('async function launch(shortcut:'));
async function scenario({ selected = 'D:\\new.txt', reject = '', remove = false } = {}) {
  const nodes = [];
  const original = { id: 'kept', name: '原名称', target: 'C:\\old.txt', icon: 'document', kind: 'local', sleeping: true, wakeDays: [1, 3] };
  const other = { ...original, id: 'other' };
  const calls = [];
  const host = { append() {} };
  const context = { shortcuts: [original, other], LOCAL_FILE_EXTENSIONS: ['txt'],
    document: { getElementById: () => null, querySelector: () => null,
      createElement: () => { const node = { setAttribute() {}, append() {}, remove() {} }; nodes.push(node); return node; } },
    element: () => host, shortcutKind: s => s.kind, inferIcon: () => 'document',
    open: async () => { if (remove) context.shortcuts = [other]; return selected; },
    invoke: async (command) => { calls.push(command); if (reject === 'validate') throw '验证失败'; },
    persist: async () => { calls.push('persist'); if (reject === 'save') throw '保存失败'; },
    render() {}, hydrateAppIcons() {}, refreshRunningApps() {}, showToast() {}, errorMessage: e => String(e),
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(implementation, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(context.isMissingTarget({ code: 'target_missing' }), true);
  assert.equal(context.isMissingTarget({ code: 'open_failed' }), false);
  assert.equal(context.isMissingTarget('找不到文件'), false);
  context.offerRelocation([original]);
  await nodes.find(n => n.textContent === '重新定位').onclick();
  return { context, original, calls };
}
(async () => {
  const success = await scenario();
  assert.deepEqual(JSON.parse(JSON.stringify(success.context.shortcuts[0])), { ...success.original, target: 'D:\\new.txt' });
  assert.equal(success.context.shortcuts[1].id, 'other');
  assert.deepEqual(success.calls, ['validate_relocation', 'persist']);
  for (const opts of [{ selected: null }, { reject: 'validate' }, { reject: 'save' }]) {
    const result = await scenario(opts);
    assert.equal(result.context.shortcuts[0], result.original);
  }
  const removed = await scenario({ remove: true });
  assert.equal(removed.context.shortcuts.length, 1);
  assert.equal(removed.calls.includes('persist'), false);
  console.log('PASS: relocation preserves metadata/order/id, cancellation, validation failure, save rollback, removed entry and typed errors');
})();
