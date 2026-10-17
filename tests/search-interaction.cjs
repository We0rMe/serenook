const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const compile = path => ts.transpileModule(fs.readFileSync(path, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const model = { exports: {} };
vm.createContext(model); vm.runInContext(compile('src/search-interaction.ts'), model);
const { SearchSelection, recordSearchShortcut, searchNavigationKey, displaySearchShortcut } = model.exports;
const key = extra => ({ key: ' ', code: 'Space', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false,
  isComposing: false, keyCode: 32, repeat: false, ...extra });

class Element {
  disabled = false; attributes = {}; events = {};
  addEventListener(type, fn) { this.events[type] = fn; }
  setAttribute(key, value) { this.attributes[key] = value; }
  fire(type, event = {}) { this.events[type]?.({ preventDefault() {}, stopPropagation() {}, ...event }); }
  blur() {}
}

(async () => {
  assert.equal(recordSearchShortcut(key()), 'Control+Alt+Space');
  assert.equal(recordSearchShortcut(key({ code: 'KeyK', key: 'K', altKey: false, shiftKey: true })), 'Control+Shift+K');
  for (const overrides of [{altKey:false}, {metaKey:true}, {isComposing:true}, {repeat:true}, {code:'F4'}, {keyCode:229}]) {
    assert.equal(recordSearchShortcut(key(overrides)), null);
  }
  assert.equal(displaySearchShortcut('Control+Alt+Space'), 'Ctrl + Alt + Space');
  assert.equal(searchNavigationKey(key({key:'Enter'})), 'open');
  for (const overrides of [{repeat:true}, {isComposing:true}, {keyCode:229}]) {
    assert.equal(searchNavigationKey(key({key:'Enter', ...overrides})), null);
  }
  const selection = new SearchSelection(); const opened = [];
  assert.equal(await selection.activate(i => opened.push(i)), false);
  selection.reset(3); assert.equal(selection.index, 0);
  selection.move(1); assert.equal(selection.index, 1);
  await Promise.all([selection.activate(i => opened.push(i)), selection.activate(i => opened.push(i))]);
  assert.deepEqual(opened, [1]);
  selection.reset(2); selection.move(99); assert.equal(selection.index, 1);
  selection.move(-99); assert.equal(selection.index, 0);
  await selection.activate(i => opened.push(i)); assert.deepEqual(opened, [1, 0]);
  selection.reset(0); assert.equal(selection.index, -1);

  const elements = Object.fromEntries(['toggle','key','apply','status'].map(id => [`#quick-search-${id}`, new Element()]));
  let persisted = null; let blocked = null; let failSave = false;
  const calls = []; let listener;
  const context = {
    exports: {}, document: { querySelector: id => elements[id], activeElement: null },
    require: name => name.endsWith('/core') ? { invoke: async (command, data) => {
      calls.push([command, data]);
      if (command === 'set_quick_search_shortcut' && data.shortcut === blocked && blocked) throw 'occupied';
    }} : name.endsWith('/event') ? { listen: async (_name, handler) => { listener = handler; return () => {}; }} : model.exports,
  };
  vm.createContext(context); vm.runInContext(compile('src/quick-search.ts'), context);
  const settings = new context.exports.QuickSearchSettings(() => persisted,
    async next => { if (failSave) throw 'disk failure'; persisted = next; }, () => true);
  await settings.initialize();
  assert.equal(elements['#quick-search-toggle'].attributes['aria-pressed'], 'false');
  elements['#quick-search-toggle'].fire('click'); await settings.flush();
  assert.equal(persisted, 'Control+Alt+Space');
  elements['#quick-search-key'].fire('keydown', key({key:'K', code:'KeyK', altKey:false, shiftKey:true}));
  blocked = 'Control+Shift+K';
  elements['#quick-search-apply'].fire('click'); await settings.flush();
  assert.equal(persisted, 'Control+Alt+Space'); assert.equal(elements['#quick-search-status'].textContent, 'occupied');
  blocked = null; failSave = true;
  elements['#quick-search-apply'].fire('click'); await settings.flush();
  assert.equal(persisted, 'Control+Alt+Space');
  assert.equal(calls.at(-1)[1].shortcut, 'Control+Alt+Space'); // failed persistence restores registration
  failSave = false;
  elements['#quick-search-apply'].fire('click'); await settings.flush();
  assert.equal(persisted, 'Control+Shift+K');
  elements['#quick-search-toggle'].fire('click'); await settings.flush();
  assert.equal(persisted, null);
  assert.equal(calls.at(-1)[1].shortcut, null);
  assert.equal(typeof listener, 'function');
  console.log('PASS: one highlighted result, single activation, empty/IME/repeat guards, recorder restrictions, conflict/save rollback, disable');
})().catch(error => { console.error(error); process.exitCode = 1; });
