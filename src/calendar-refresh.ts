export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// Timers can be suspended during sleep. A short check and focus/visibility events
// recover from that, and from changes to the system date or time zone.
export function watchCalendarDay(update: (now: Date) => void, now = () => new Date()): () => void {
  let key = localDateKey(now());
  const check = () => {
    const current = now();
    const next = localDateKey(current);
    if (next === key) return;
    key = next;
    update(current);
  };
  const timer = window.setInterval(check, 15_000);
  window.addEventListener("focus", check);
  document.addEventListener("visibilitychange", check);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", check);
    document.removeEventListener("visibilitychange", check);
  };
}
