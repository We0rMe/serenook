// Production native-drop handling; no browser and no user files are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../node_modules/typescript');
const timers = new Map();
let timerId = 0;
const sandbox = { exports: {}, Error,
  setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: id => timers.delete(id),
};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/shortcut-drop.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, sandbox);
const { ShortcutDropController, localEntryIdentity } = sandbox.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const fixtureDraft = { name: '计划.v2', target: 'C:\\资料\\计划.v2.pdf', kind: 'local' };
const event = (type, paths = [fixtureDraft.target], x = 187.5, y = 187.5) => ({ type, paths, position: { x, y } });
function fixture(overrides = {}) {
  const state = { available: true, feedback: [], opened: [], messages: [], inspected: [], scale: 1.25 };
  const options = {
    available: () => state.available,
    scale: () => state.scale,
    hitTest: (x, y) => x >= 100 && x <= 600 && y >= 100 && y <= 300 ? y > 220 ? 'sleep' : 'awake' : null,
    feedback: (target, message) => state.feedback.push({ target, message }),
    inspect: async path => { state.inspected.push(path); return clone(fixtureDraft); },
    problem: () => null,
    open: (draft, sleeping) => state.opened.push({ draft, sleeping }),
    notify: message => state.messages.push(message),
    ...overrides,
  };
  return { state, options, controller: new ShortcutDropController(options) };
}
(async () => {
  const f = fixture();
  await f.controller.handle(event('enter'));
  assert.deepEqual(f.state.feedback.at(-1), { target: 'awake', message: '松手添加入口' });
  await f.controller.handle(event('over', undefined, 187.5, 300));
  assert.equal(f.state.feedback.at(-1).target, 'sleep');
  await f.controller.handle(event('over', undefined, 20, 20));
  assert.equal(f.state.feedback.at(-1).target, null);
  await f.controller.handle({ type: 'leave' });
  assert.equal(f.state.opened.length, 0);
  await f.controller.handle(event('drop'));
  assert.deepEqual(f.state.opened, [{ draft: fixtureDraft, sleeping: false }]);
  await f.controller.handle(event('drop', undefined, 187.5, 300));
  assert.equal(f.state.opened.at(-1).sleeping, true);
  assert.equal(f.state.feedback.at(-1).target, null);
  assert.equal(timers.size, 0);

  const ignored = fixture();
  await ignored.controller.handle(event('drop', ['one', 'two']));
  assert.equal(ignored.state.inspected.length, 0);
  assert.equal(ignored.state.messages.length, 1);
  await ignored.controller.handle(event('drop', undefined, 0, 0));
  ignored.state.available = false; // Modal editor, hidden module, guide, or settings.
  await ignored.controller.handle(event('drop'));
  ignored.state.available = true;
  for (const scale of [0, Infinity, NaN]) {
    ignored.state.scale = scale;
    await ignored.controller.handle(event('drop'));
  }
  assert.equal(ignored.state.inspected.length, 0);
  assert.equal(ignored.state.opened.length, 0);

  const duplicate = fixture({ problem: () => '这个位置已在常用入口中。' });
  await duplicate.controller.handle(event('drop'));
  assert.equal(duplicate.state.opened.length, 0);
  assert.deepEqual(duplicate.state.messages, ['这个位置已在常用入口中。']);
  const failed = fixture({ inspect: async () => { throw Error('无法读取'); } });
  await failed.controller.handle(event('drop'));
  assert.deepEqual(failed.state.messages, ['无法读取']);
  assert.equal(failed.state.feedback.at(-1).target, null);

  let complete;
  const slow = fixture({ inspect: () => new Promise(resolve => { complete = resolve; }) });
  const pending = slow.controller.handle(event('drop'));
  await slow.controller.handle(event('drop'));
  slow.controller.cancel(); // A newer click or keystroke wins.
  complete(fixtureDraft);
  await pending;
  assert.equal(slow.state.opened.length, 0);
  assert.equal(slow.state.messages.length, 0);
  const changed = slow.controller.handle(event('drop'));
  slow.state.available = false;
  complete(fixtureDraft);
  await changed;
  assert.equal(slow.state.opened.length, 0);
  slow.state.available = true;
  const closing = slow.controller.handle(event('drop'));
  slow.controller.dispose();
  complete(fixtureDraft);
  await closing;
  assert.equal(slow.state.opened.length, 0);

  const timeout = fixture({ inspect: () => new Promise(() => {}) });
  const waiting = timeout.controller.handle(event('drop'));
  [...timers.values()].forEach(callback => callback());
  await waiting;
  assert.match(timeout.state.messages[0], /读取未完成/);
  assert.equal(timers.size, 0);
  assert.equal(timeout.state.feedback.at(-1).target, null);

  // A canceled request must not clear a newer request's loading feedback.
  const resolvers = [];
  const race = fixture({ inspect: () => new Promise(resolve => resolvers.push(resolve)) });
  const old = race.controller.handle(event('drop'));
  race.controller.cancel();
  const latest = race.controller.handle(event('drop'));
  const before = race.state.feedback.length;
  resolvers[0](fixtureDraft);
  await old;
  assert.equal(race.state.feedback.length, before);
  resolvers[1](fixtureDraft);
  await latest;
  assert.equal(race.state.opened.length, 1);

  assert.equal(localEntryIdentity('C:/Tools/App.LNK', 'local'), localEntryIdentity('c:\\tools\\app.lnk', 'local'));
  assert.equal(localEntryIdentity('C:/Notes/', 'folder'), localEntryIdentity('c:\\notes', 'folder'));
  assert.equal(localEntryIdentity('\\\\?\\C:\\Notes', 'folder'), localEntryIdentity('c:\\notes', 'folder'));
  assert.equal(localEntryIdentity('\\\\?\\UNC\\host\\share', 'folder'), localEntryIdentity('\\\\host\\share\\', 'folder'));
  assert.notEqual(localEntryIdentity('C:/App.exe', 'local'), localEntryIdentity('C:/App.lnk', 'local'));
  assert.equal(localEntryIdentity('https://example.com', 'web'), null);
  console.log('PASS: native drop DPI/hit testing, hover/leave, sleep destination, multi-file refusal, modal guard, duplicates, failures, cancellation, timeout, stale-result protection, Windows path identity');
})().catch(error => { console.error(error); process.exitCode = 1; });
