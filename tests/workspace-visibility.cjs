// Exercise production preference transitions without touching the user's workspace.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const source = fs.readFileSync('src/main.ts', 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = [
  'isWorkspaceModuleId', 'normalizeWorkspaceOrder', 'normalizeModuleSelection',
  'saveSettingsPatch', 'isWorkspaceModuleActive', 'applyWorkspaceOrder',
  'renderWorkspaceModules', 'changeWorkspacePreferences', 'toggleWorkspaceVisibility',
  'toggleWorkspaceModule', 'revealWorkspaceModule', 'finishModuleDrag',
  'hasSameIds', 'hasSameOrder', 'closestReorderTarget', 'reorderTargetBounds',
];
const selected = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(selected.length, names.length);
const code = ts.transpileModule(selected.map(n => n.getText(parsed)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const clone = value => JSON.parse(JSON.stringify(value));
const ids = ['shortcuts', 'checklists', 'diaries', 'scratchpad', 'music'];
function node(id) {
  const classes = new Set();
  return {
    dataset: { moduleId: id, workspaceVisibility: id }, hidden: false, inert: false,
    attrs: {}, setAttribute(name, value) { this.attrs[name] = value; },
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    querySelector: () => null,
  };
}
const modules = new Map(ids.map(id => [id, { module: node(id), toggle: node(id), content: node(id) }]));
let order = [...ids];
let writes = [];
let flushes = 0;
let restores = 0;
let failures = [];
const data = { shortcuts: [{ id: 'entry', target: 'D:/notes' }], checklists: [{ id: 'list', tasks: [{ content: '保留', completed: true }] }], diaries: [{ content: '原文' }] };
const ctx = {
  WORKSPACE_MODULE_IDS: ids,
  settings: { workspaceOrder: [...ids], collapsedModules: ['music'], hiddenModules: [], theme: 'dark', anniversaryName: 'Birth', anniversaryDate: '2000-01-01' },
  settingsSaveQueue: Promise.resolve(), workspacePreferencesSaving: false, moduleDragState: null,
  ...clone(data),
  workspaceModuleElements: id => modules.get(id),
  workspaceVisibilityButtons: ids.map(node),
  workspaceSections: {
    children: { item: index => modules.get(order[index])?.module ?? null },
    querySelectorAll: () => order.map(id => modules.get(id).module),
    insertBefore(module, reference) {
      order = order.filter(id => id !== module.dataset.moduleId);
      order.splice(reference ? order.indexOf(reference.dataset.moduleId) : order.length, 0, module.dataset.moduleId);
    },
  },
  invoke: async (command, { settings }) => { assert.equal(command, 'save_settings'); writes.push(clone(settings)); },
  scratchpadEditor: { flush: async () => { flushes++; }, restoreView: () => { restores++; } },
  requestAnimationFrame: callback => callback(),
  showToast: message => failures.push(message), errorMessage: error => error.message,
  clearModuleDragState: () => { ctx.moduleDragState = null; },
  document: { elementFromPoint: () => null },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

(async () => {
  assert.deepEqual(clone(ctx.normalizeModuleSelection(undefined)), []);
  assert.deepEqual(clone(ctx.normalizeModuleSelection(['music', 'unknown', 'music', 'diaries', 1])), ['music', 'diaries']);
  assert.deepEqual(clone(ctx.normalizeWorkspaceOrder(['diaries', 'diaries', 'unknown'])), ['diaries', 'shortcuts', 'checklists', 'scratchpad', 'music']);
  const original = clone(ctx.settings);
  await ctx.toggleWorkspaceVisibility('music');
  assert.equal(modules.get('music').module.hidden, true);
  assert.equal(modules.get('music').module.inert, true);
  assert.equal(modules.get('music').content.attrs['aria-hidden'], 'true');
  assert.equal(ctx.isWorkspaceModuleActive('music'), false);
  assert.deepEqual(clone(ctx.settings.collapsedModules), original.collapsedModules);
  assert.equal(ctx.workspaceVisibilityButtons[4].attrs['aria-pressed'], 'false');
  await ctx.toggleWorkspaceVisibility('music');
  assert.deepEqual(clone(ctx.settings), original);
  assert.equal(modules.get('music').module.hidden, false);
  assert.equal(modules.get('music').content.inert, true); // Still folded, as before.

  await ctx.toggleWorkspaceVisibility('scratchpad');
  assert.equal(flushes, 1);
  assert.equal(ctx.isWorkspaceModuleActive('scratchpad'), false);
  await ctx.toggleWorkspaceVisibility('scratchpad');
  assert.equal(restores, 1);
  assert.deepEqual(clone(ctx.settings), original);

  // All modules may be hidden, but no data or other preferences are removed.
  await ctx.changeWorkspacePreferences({ hiddenModules: [...ids] });
  assert.equal(ctx.workspaceSections.hidden, true);
  assert.equal([...modules.values()].every(({ module, content }) => module.hidden && content.inert), true);
  for (const key of Object.keys(data)) assert.deepEqual(clone(ctx[key]), data[key]);
  assert.deepEqual(clone(ctx.settings.workspaceOrder), original.workspaceOrder);
  assert.equal(ctx.settings.anniversaryDate, original.anniversaryDate);

  // Search/navigation reveals only its destination, with a single saved change.
  for (const id of ['diaries', 'checklists', 'scratchpad']) {
    const beforeWrites = writes.length;
    assert.equal(await ctx.revealWorkspaceModule(id), true);
    assert.equal(ctx.isWorkspaceModuleActive(id), true);
    assert.equal(writes.length, beforeWrites + 1);
    assert.equal(ctx.settings.hiddenModules.includes('music'), true);
  }
  assert.equal(ctx.workspaceSections.hidden, false);
  const beforeNoop = writes.length;
  assert.equal(await ctx.revealWorkspaceModule('diaries'), true);
  assert.equal(writes.length, beforeNoop);

  // Failed flushing or saving leaves both data and visibility untouched.
  const beforeFailure = clone(ctx.settings);
  const normalInvoke = ctx.invoke;
  ctx.scratchpadEditor.flush = async () => { throw Error('flush failed'); };
  await ctx.toggleWorkspaceVisibility('scratchpad');
  assert.deepEqual(clone(ctx.settings), beforeFailure);
  assert.equal(ctx.workspacePreferencesSaving, false);
  ctx.scratchpadEditor.flush = async () => { flushes++; };
  ctx.invoke = async () => { throw Error('save failed'); };
  await ctx.toggleWorkspaceVisibility('diaries');
  assert.deepEqual(clone(ctx.settings), beforeFailure);
  assert.equal(modules.get('diaries').module.hidden, false);
  assert.equal(ctx.workspaceVisibilityButtons.every(button => button.attrs['aria-disabled'] === 'false'), true);
  ctx.invoke = normalInvoke;
  await ctx.saveSettingsPatch({ theme: 'light' });
  assert.equal(ctx.settings.theme, 'light'); // A failed save doesn't poison the queue.

  // Settings changes queued during a slow save merge, rather than replacing one another.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let activeSaves = 0;
  let maxSaves = 0;
  ctx.invoke = async (command, value) => {
    activeSaves++;
    maxSaves = Math.max(maxSaves, activeSaves);
    await gate;
    await normalInvoke(command, value);
    activeSaves--;
  };
  const first = ctx.saveSettingsPatch({ hiddenModules: ['diaries'] });
  const second = ctx.saveSettingsPatch({ theme: 'dark' });
  release();
  await Promise.all([first, second]);
  assert.equal(maxSaves, 1);
  assert.deepEqual(clone(ctx.settings.hiddenModules), ['diaries']);
  assert.equal(ctx.settings.theme, 'dark');
  assert.deepEqual(writes.at(-1), clone(ctx.settings));
  ctx.invoke = normalInvoke;

  // Reordering visible modules keeps hidden modules in their original slots.
  ctx.settings.workspaceOrder = [...ids];
  ctx.renderWorkspaceModules();
  order = ['music', 'shortcuts', 'checklists', 'diaries', 'scratchpad'];
  ctx.moduleDragState = { live: { pointerId: 1 }, previousOrder: [...ids] };
  await ctx.finishModuleDrag({ pointerId: 1 });
  assert.deepEqual(clone(ctx.settings.workspaceOrder), ['music', 'shortcuts', 'diaries', 'checklists', 'scratchpad']);
  assert.deepEqual(order, clone(ctx.settings.workspaceOrder));

  // Hidden zero-sized nodes cannot become drag targets near the origin.
  const hidden = modules.get('diaries').module;
  const visible = modules.get('music').module;
  visible.getBoundingClientRect = () => ({ top: 200, left: 100, width: 500, height: 64 });
  assert.equal(ctx.closestReorderTarget({ container: { querySelectorAll: () => [hidden, visible] }, source: null, itemSelector: '.workspace-module' }, 0, 0), visible);

  assert.deepEqual(failures, ['flush failed', 'save failed']);
  for (const key of Object.keys(data)) assert.deepEqual(clone(ctx[key]), data[key]);
  console.log('PASS: legacy defaults, visibility and collapse, all-hidden workspace, scratchpad flush, search reveal, save failure, serialized preferences, hidden-slot reorder, hidden drag targets, data retention');
})().catch(error => { console.error(error); process.exitCode = 1; });
