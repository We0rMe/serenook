const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../node_modules/typescript');
const sandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/text-location.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, sandbox);
const { locateText, textExcerpt } = sandbox.exports;
for (const [text, terms, expected] of [
  ['🌱 开学\n无事发生', ['无事'], '无事'],
  ['前文 ＡＢＣ 后文', ['abc'], 'ＡＢＣ'],
  ['前文 ﬃ 后文', ['ffi'], 'ﬃ'],
  ['前文 e\u0301 后文', ['é'], 'e\u0301'],
  ['前文 ΟΣ 后文', ['ος'], 'ΟΣ'],
  ['second then FIRST', ['first', 'second'], 'second'],
  ['前文 <script>alert(1)</script>', ['<script>'], '<script>'],
]) {
  const match = locateText(text, terms);
  assert.ok(match);
  assert.equal(text.slice(match.start, match.end), expected);
}
assert.equal(locateText('没有匹配', ['xyz']), null);
const text = '开头\n'.repeat(80) + '寻找此处' + '末尾'.repeat(80);
const excerpt = textExcerpt(text, locateText(text, ['寻找']));
assert.ok(excerpt.includes('寻找此处'));
assert.ok(excerpt.startsWith('…'));
console.log('PASS: original offsets, Unicode normalization, earliest match, plain-text safety, contextual excerpts');

// Native transitionend can settle the reader before its fallback timer fires.
const main = fs.readFileSync('src/main.ts', 'utf8');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.ES2022, true);
const settle = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'settleDiaryReader');
let reveals = 0;
const classes = new Set(['is-open']);
const reader = {
  window: { clearTimeout() {} }, diaryReaderSettleTimer: 1,
  diaryReaderDialog: { open: true, classList: { contains: name => classes.has(name), add: name => classes.add(name) } },
  diaryReaderReveal: () => reveals++,
};
vm.createContext(reader);
vm.runInContext(ts.transpileModule(settle.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, reader);
reader.settleDiaryReader(); reader.settleDiaryReader();
assert.equal(reveals, 1, 'Transition completion must reveal exactly once, even before the fallback timer');
assert.ok(classes.has('is-settled'));
console.log('PASS: diary search reveal survives early animation completion');
