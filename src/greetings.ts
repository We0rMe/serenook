const DAY_MS = 86_400_000;
const MORNING = [
  "周日好，留一点自己的时间。",
  "周一好，新的一周，从这里开始。",
  "周二好，我们接着来。",
  "周三好，行至一周中间。",
  "周四好，回到熟悉的节奏。",
  "周五快乐！！！",
  "周六好，今天由你安排。",
] as const;

const PERIODS = [
  [360, ["夜深了，一起收个尾。", "夜深了，余下的明日继续。", "夜深了，今天就到这里。"]],
  [570, MORNING],
  [690, ["上午好，从这里开始。", "上午好，手边的事，一起开始。", "上午好，今天也已就绪。"]],
  [810, ["午安，我们稍后继续。", "中午好，先告一段落。", "中午好，上午辛苦了。"]],
  [1050, ["下午好，我们接着来。", "下午好，接上之前的思路。", "下午好，回到熟悉的节奏。"]],
  [1230, ["傍晚了，一起收个尾。", "傍晚好，今天渐近尾声。", "傍晚好，手边还有一点余光。"]],
  [1440, ["晚上好，熟悉的位置。", "晚上好，从手边这件事开始。", "晚上好，把今天收拾妥当。"]],
] as const;

export function ordinaryGreeting(now: Date): string {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const index = PERIODS.findIndex(([end]) => minutes < end);
  if (index === 1) return MORNING[now.getDay()];
  const pool = PERIODS[index][1];
  const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
  // Different periods have different phase offsets, stable across restarts.
  return pool[((day + index) % pool.length + pool.length) % pool.length];
}
