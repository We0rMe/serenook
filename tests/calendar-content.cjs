const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
function load(name, extra = {}) {
  const context = { exports: {}, Date, require: id => load(id.replace('./', '')), ...extra };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`src/${name}.ts`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return context.exports;
}
const { DAILY_QUOTES, dailyQuote } = load('daily-quotes');
assert.equal(DAILY_QUOTES.length, 527);
assert.equal(new Set(DAILY_QUOTES).size, 527);
assert.ok(DAILY_QUOTES.every(q => typeof q === 'string' && [...q].length <= 30));
const start = new Date(2026, 7, 26, 1);
assert.equal(dailyQuote(start), dailyQuote(new Date(2026, 7, 26, 23)));
const cycle = new Date(start); cycle.setDate(cycle.getDate() + 527);
assert.equal(dailyQuote(start), dailyQuote(cycle));
const { ordinaryGreeting } = load('greetings');
assert.equal(ordinaryGreeting(new Date(2026, 10, 20, 8)), '周五快乐！！！');
assert.equal(ordinaryGreeting(new Date(2026, 10, 16, 15)), ordinaryGreeting(new Date(2026, 10, 16, 16)));
assert.equal(new Set([16, 17, 18].map(day => ordinaryGreeting(new Date(2026, 10, day, 15)))).size, 3);
const handlers = new Map(); let tick; let stopped = false;
const events = { addEventListener: (key, fn) => handlers.set(key, fn), removeEventListener: key => handlers.delete(key) };
const calendar = load('calendar-refresh', {
  window: { ...events, setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { stopped = true; } },
  document: events,
});
let now = new Date(2026, 10, 15, 23, 59); const seen = [];
const dispose = calendar.watchCalendarDay(date => seen.push(calendar.localDateKey(date)), () => now);
tick(); assert.equal(seen.length, 0);
now = new Date(2026, 10, 16, 0, 0); tick();
assert.equal(seen.length, 1); tick(); assert.equal(seen.length, 1);
now = new Date(2026, 10, 19, 8); handlers.get('focus')();
assert.equal(seen.at(-1), '2026-11-19');
now = new Date(2026, 10, 18, 23); handlers.get('visibilitychange')();
assert.equal(seen.at(-1), '2026-11-18');
dispose(); assert.equal(stopped, true); assert.equal(handlers.size, 0);
console.log('PASS: 527 unique short quotes, daily cycle, Friday copy, stable varied greetings, midnight/sleep/clock recovery');
