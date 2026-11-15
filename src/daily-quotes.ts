const MILLISECONDS_PER_DAY = 86_400_000;
const DAILY_QUOTE_EPOCH = Date.UTC(2026, 7, 26);

export { DAILY_QUOTES } from "./quote-content";
import { DAILY_QUOTES } from "./quote-content";

export function dailyQuote(date = new Date()): string {
  const localDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const elapsedDays = Math.floor((localDay - DAILY_QUOTE_EPOCH) / MILLISECONDS_PER_DAY);
  const index = ((elapsedDays % DAILY_QUOTES.length) + DAILY_QUOTES.length) % DAILY_QUOTES.length;
  return DAILY_QUOTES[index];
}
