export interface HolidayGreetingSet {
  name: string;
  greetings: readonly [string, string, string];
}

const FIXED_HOLIDAYS = new Map<string, HolidayGreetingSet>([
  ["01-01", {
    name: "元旦",
    greetings: [
      "元旦安好，新岁初启，愿今天从容明亮。",
      "把旧页轻轻合上，也把新日认真打开。",
      "岁序更新，今夜宜为来日留一盏灯。",
    ],
  }],
  ["05-01", {
    name: "劳动节",
    greetings: [
      "劳动节安，今天也该把忙碌轻轻放下。",
      "认真生活的人，值得一段不被催促的午后。",
      "歇一歇，让双手与心都回到松弛处。",
    ],
  }],
  ["10-01", {
    name: "国庆节",
    greetings: [
      "今日国庆，山河明朗，家国同庆。",
      "看人间烟火，也看万里山河铺展。",
      "华灯初上，愿盛世长安，万家安然。",
    ],
  }],
  ["10-31", {
    name: "万圣节",
    greetings: [
      "万圣夜到了，南瓜灯替夜色眨了眨眼。",
      "糖果、面具与一点顽皮，都是今夜的通行证。",
      "夜色有怪趣，愿所有惊吓都止于玩笑。",
    ],
  }],
  ["12-25", {
    name: "圣诞节",
    greetings: [
      "圣诞到了，愿铃声与松香轻轻入窗。",
      "把一份小小心意，藏进冬日的红与绿。",
      "灯串亮起，愿今夜有雪，也有温暖可归。",
    ],
  }],
]);

const LUNAR_HOLIDAYS = new Map<string, HolidayGreetingSet>([
  ["1-1", {
    name: "春节",
    greetings: [
      "新春到了，愿灯火可亲，团圆有期。",
      "围炉话旧，寻常一餐也是人间好年景。",
      "爆竹声远，且把新愿安放在今夜。",
    ],
  }],
  ["1-15", {
    name: "元宵节",
    greetings: [
      "元宵到了，上元灯明，人间有团圆。",
      "一碗汤圆，一城灯火，都是圆满的模样。",
      "月上柳梢，且随灯影看人间。",
    ],
  }],
  ["5-5", {
    name: "端午节",
    greetings: [
      "端午安康，艾叶清香，舟鼓将起。",
      "粽叶一层层，裹住的是故乡与惦念。",
      "江风送晚，愿岁岁安康，所念皆安。",
    ],
  }],
  ["7-7", {
    name: "七夕",
    greetings: [
      "今夕七夕，星河之下，心意有期。",
      "相逢不必喧哗，长久自有回声。",
      "夜看牵牛织女星，愿所爱隔山海也相知。",
    ],
  }],
  ["8-15", {
    name: "中秋节",
    greetings: [
      "中秋到了，月将圆，归心也有了方向。",
      "桂香入窗，且分一轮秋月与故人。",
      "海上生明月，天涯共此时。",
    ],
  }],
  ["9-9", {
    name: "重阳节",
    greetings: [
      "今日重阳，秋高宜登临。",
      "登高望远，也回望一路来时。",
      "菊香渐晚，愿长者安康，岁月从容。",
    ],
  }],
]);

const NEW_YEARS_EVE: HolidayGreetingSet = {
  name: "除夕",
  greetings: [
    "岁至除夕，归途与灯火都在等你。",
    "围坐一席，把这一年的风尘慢慢说完。",
    "今夜守岁，愿旧事落定，新愿有声。",
  ],
};

const QINGMING: HolidayGreetingSet = {
  name: "清明节",
  greetings: [
    "又到清明，风轻雨细，宜念故人。",
    "踏青看新绿，也让思念有处安放。",
    "暮色清明，愿记忆温柔，不惊旧梦。",
  ],
};

const LUNAR_MONTHS: Record<string, number> = {
  正月: 1,
  二月: 2,
  三月: 3,
  四月: 4,
  五月: 5,
  六月: 6,
  七月: 7,
  八月: 8,
  九月: 9,
  十月: 10,
  冬月: 11,
  十一月: 11,
  腊月: 12,
  十二月: 12,
};

const lunarFormatter = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
  month: "long",
  day: "numeric",
});

interface LunarDate {
  month: number;
  day: number;
  isLeapMonth: boolean;
}

function lunarDate(date: Date): LunarDate | null {
  const parts = lunarFormatter.formatToParts(date);
  const monthPart = parts.find((part) => part.type === "month")?.value;
  const dayPart = parts.find((part) => part.type === "day")?.value;
  if (!monthPart || !dayPart) return null;

  const isLeapMonth = monthPart.startsWith("闰");
  const month = LUNAR_MONTHS[monthPart.replace(/^闰/, "")];
  const day = Number(dayPart);
  return month && Number.isInteger(day) ? { month, day, isLeapMonth } : null;
}

function qingmingDay(year: number): number | null {
  if (year < 2000 || year > 2099) return null;
  const shortYear = year % 100;
  return Math.floor(shortYear * 0.2422 + 4.81) - Math.floor(shortYear / 4);
}

function nextCalendarDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12);
}

export function holidayForDate(date: Date): HolidayGreetingSet | null {
  const monthDay = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const fixedHoliday = FIXED_HOLIDAYS.get(monthDay);
  if (fixedHoliday) return fixedHoliday;

  if (date.getMonth() === 3 && date.getDate() === qingmingDay(date.getFullYear())) return QINGMING;

  const lunar = lunarDate(date);
  if (!lunar) return null;
  const tomorrow = lunarDate(nextCalendarDay(date));
  if (tomorrow && !tomorrow.isLeapMonth && tomorrow.month === 1 && tomorrow.day === 1) return NEW_YEARS_EVE;
  if (lunar.isLeapMonth) return null;
  return LUNAR_HOLIDAYS.get(`${lunar.month}-${lunar.day}`) ?? null;
}

export function holidayGreeting(date: Date): string | null {
  const holiday = holidayForDate(date);
  if (!holiday) return null;
  const hour = date.getHours();
  const period = hour < 12 ? 0 : hour < 18 ? 1 : 2;
  return holiday.greetings[period];
}
