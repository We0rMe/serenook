// Exercise stale responses, source changes and command routing without touching a real player.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
class Element {
  hidden = false; disabled = false; value = ''; textContent = ''; dataset = {}; handlers = {}; attrs = {};
  children = [];
  style = { setProperty() {}, removeProperty() {} };
  classes = new Set();
  classList = { add: (...names) => names.forEach(n => this.classes.add(n)), remove: (...names) => names.forEach(n => this.classes.delete(n)), contains: n => this.classes.has(n), toggle: (n, on) => on ? this.classes.add(n) : this.classes.delete(n) };
  animate() {} scrollTo() {}
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}
const elements = new Map();
const root = new Element();
root.querySelector = key => { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); };
const pending = [];
const invoke = (command, args) => new Promise((resolve, reject) => pending.push({ command, args, resolve, reject }));
const storage = new Map([['serenook.music.online','false']]);
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const lyricContext = { exports: {}, localStorage, Date };
vm.createContext(lyricContext);
vm.runInContext(ts.transpileModule(fs.readFileSync('src/music-lyrics.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, lyricContext);
const context = { exports: {}, localStorage, performance, require: id => id.endsWith('/core') ? { invoke } : id.endsWith('/window') ? {getCurrentWindow: () => ({onResized: async () => {}})} : id === './music-lyrics' ? lyricContext.exports : {},
  document: { hidden: false, createElement: () => new Element(), getElementById: () => new Element(), addEventListener() {} },
  window: { setInterval() {}, setTimeout, clearTimeout, matchMedia: () => ({matches:true}) }, MutationObserver: class { observe() {} }, ResizeObserver: class { observe() {} },
  Option: class { constructor(label, value) { this.label = label; this.value = value; } },
};
vm.createContext(context);
vm.runInContext(ts.transpileModule(fs.readFileSync('src/music.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
const flush = () => new Promise(resolve => setImmediate(resolve));
const state = { sources: [{id:'1',appId:'QQMusic.exe'}, {id:'2',appId:'Spotify.exe'}], selected:'1',
  title:'Song',artist:'Artist',cover:null,playing:false,canPlay:true,canPause:false,
  canPrevious:true,canNext:true,canShuffle:false,canRepeat:false,shuffle:null,repeat:null };
(async () => {
  const music = new context.exports.MusicCompanion(root, () => true);
  music.online = false; // Keep source-routing tests independent of lyric requests.
  pending.shift().resolve(state); await flush();
  assert.equal(music.buttons.get('shuffle').hidden, true);
  assert.equal(music.buttons.get('repeat').hidden, true);
  assert.equal(music.buttons.get('toggle').disabled, false);
  assert.equal(elements.get('.music-state').textContent, 'QQ 音乐');
  assert.equal(root.classList.contains('is-idle'), false, 'connected sources restore the full player');
  assert.ok(!root.innerHTML.includes('music-options') && !root.innerHTML.includes('music-lyric-credit'));
  const oldRefresh = music.refresh(); const oldRequest = pending.shift();
  music.select.value = '2'; music.select.handlers.change();
  oldRequest.resolve({...state,title:'Stale song'}); await oldRefresh; await flush();
  assert.notEqual(music.title.textContent, 'Stale song');
  assert.equal(pending[0].args.preferred, '2');
  pending.shift().resolve({...state,selected:'2',title:'Selected song',playing:true,canPlay:false,canPause:true}); await flush();
  const action = music.control('toggle'); const command = pending.shift();
  assert.equal(command.command, 'media_control');
  assert.equal(command.args.id, '2'); assert.equal(command.args.action, 'pause');
  await music.control('next'); assert.equal(pending.length, 0, 'busy commands must not duplicate');
  command.reject('Player stopped'); await flush();
  pending.shift().resolve({...state,selected:null,sources:[]}); await action;
  assert.equal(music.controls.hidden, true);
  assert.equal(root.classList.contains('is-idle'), true, 'exited sources use the compact empty state');
  assert.equal(music.artist.textContent, '', 'empty state must not repeat its guidance below the title');
  assert.equal(music.select.value, '2', 'an exited pinned player must not silently fall back');
  assert.equal(music.status.textContent, 'Player stopped');
  music.snapshot = state;
  let deadline;
  context.window.setTimeout = callback => { deadline = callback; return 1; };
  context.window.clearTimeout = () => {};
  const timedControl = music.control('toggle');
  pending.shift(); // deliberately leave the native reply unresolved
  deadline(); await flush();
  assert.equal(music.busy, false, 'a missing IPC reply must release the controls');
  assert.match(music.status.textContent, /响应超时/);
  pending.shift().resolve(state); await timedControl;
  context.window.setTimeout = setTimeout; context.window.clearTimeout = clearTimeout;
  music.online = true;
  music.snapshot = {...state, title:'First',duration:180,position:0}; music.track = lyricContext.exports.songKey('First','Artist');
  const first = music.loadLyrics(), firstRequest = pending.shift();
  music.snapshot = {...state, title:'Second',duration:180,position:0}; music.track = lyricContext.exports.songKey('Second','Artist');
  const second = music.loadLyrics(), secondRequest = pending.shift();
  secondRequest.resolve({syncedLyrics:'[00:01.00]Current song'}); await second;
  firstRequest.resolve({syncedLyrics:'[00:01.00]Stale song'}); await first;
  assert.equal(music.lines[0].text, 'Current song', 'late lyrics must not replace the new track');
  const request = music.loadLyrics(); // cached lyrics do not make a request
  await request; assert.equal(pending.length, 0);
  const rematch = music.loadLyrics(true), rematchRequest = pending.shift();
  assert.equal(rematchRequest.command, 'music_lyrics', 'refresh must bypass cached lyrics');
  rematchRequest.resolve({syncedLyrics:'[00:01.00]Rematched song'}); await rematch;
  assert.equal(music.lines[0].text, 'Rematched song');
  music.snapshot = {...state,duration:180,position:20,canSeek:true}; music.position = 20;
  const seeking = music.seek(999); const seekRequest = pending.shift();
  assert.equal(seekRequest.command, 'media_seek'); assert.equal(seekRequest.args.seconds, 180);
  assert.equal(music.progress.disabled, true, 'disable duplicate seek while command pending');
  assert.equal(music.position, 180, 'show immediate seek preview');
  seekRequest.reject('Seek rejected'); await flush();
  assert.equal(music.position, 20, 'rejected seeks roll back');
  music.online = false;
  pending.shift().resolve({...state,duration:180,position:20,canSeek:true}); await seeking;
  music.online = true;
  music.snapshot = {...state,title:'Third'}; music.track = lyricContext.exports.songKey('Third','Artist');
  const online = music.loadLyrics(), onlineRequest = pending.shift();
  music.online = false; await music.loadLyrics();
  onlineRequest.resolve({syncedLyrics:'[00:00]Discard me'}); await online;
  assert.equal(music.lines.length, 0, 'disabling online lyrics invalidates pending results');
  console.log('PASS: stale response rejection, pinned source routing, capability controls, duplicate prevention, exited player and command failure');
  console.log('PASS: lyric request races, cache reuse and disabling online matching');
  console.log('PASS: missing IPC response releases busy state and restores polling');
})().catch(error => { console.error(error); process.exitCode = 1; });
