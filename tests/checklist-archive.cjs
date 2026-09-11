// Exercise the production state transitions without opening or changing a user's workspace.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const source = fs.readFileSync('src/main.ts', 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const names = ['localDateKey', 'applyDailyChecklistResets', 'setChecklistArchived', 'finishChecklistCardDrag', 'hasSameIds', 'hasSameOrder'];
const selected = parsed.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
assert.equal(selected.length, names.length);
const code = ts.transpileModule(selected.map(n => n.getText(parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const task = { id:'task', content:'保留原记录', completed:true, important:true, shortcutId:'entry' };
const stored = { id:'stored', name:'已收存', archived:true, dailyReset:true, lastResetDate:'2026-09-01', tasks:[task] };
const clone = x => JSON.parse(JSON.stringify(x));
const ctx = {
  checklists: [], editingChecklistId:null, focusedChecklistId:null,
  renderChecklists(){}, showToast(){}, closeChecklistFocus(){},
  persistChecklistChanges:async () => true,
  clearChecklistCardDragState(){ctx.checklistCardDragState=null;},
  checklistGrid:{ querySelectorAll:() => ['last','first'].map(id => ({dataset:{checklistId:id}})) },
};
vm.createContext(ctx); vm.runInContext(code,ctx);
(async () => {
  ctx.checklists = [clone(stored), { ...clone(stored), id:'active', archived:false }];
  ctx.applyDailyChecklistResets(new Date(2026,8,8,12));
  assert.deepEqual(clone(ctx.checklists[0]), stored);
  assert.equal(ctx.checklists[1].tasks[0].completed,false);
  await ctx.setChecklistArchived('stored',false);
  assert.deepEqual(clone(ctx.checklists[0].tasks[0]),task);
  assert.equal(ctx.checklists[0].lastResetDate,ctx.localDateKey());
  ctx.applyDailyChecklistResets(new Date());
  assert.equal(ctx.checklists[0].tasks[0].completed,true);
  const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);
  ctx.applyDailyChecklistResets(tomorrow);
  assert.equal(ctx.checklists[0].tasks[0].completed,false);
  ctx.checklists=[{...clone(stored),id:'first',archived:false},clone(stored),{...clone(stored),id:'last',archived:false}];
  ctx.checklistCardDragState={live:{pointerId:1},previousOrder:['first','last']};
  await ctx.finishChecklistCardDrag({pointerId:1});
  assert.deepEqual(clone(ctx.checklists).map(x=>x.id),['last','stored','first']);
  assert.deepEqual(clone(ctx.checklists[1]),stored);
  const before=clone(ctx.checklists[0]);
  await ctx.setChecklistArchived('last',true);
  assert.deepEqual(clone(ctx.checklists[0]),{...before,archived:true});
  console.log('PASS: archived reset pause, restoration day preservation, next-day reset, visible reorder retention, archive content preservation');
})().catch(error=>{console.error(error);process.exitCode=1;});
