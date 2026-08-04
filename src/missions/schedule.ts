/**
 * Say when in English, get a cron expression.
 *
 * Missions already supported `cadence: 'scheduled'` with a `cron` field, and
 * nothing could set it except by writing `0 7 * * *` by hand. Stating an
 * objective and when it should recur is the natural way to ask for recurring
 * work, and requiring cron syntax is what stops that being used at all.
 *
 * Deliberately small. This covers the phrasings a person actually uses and
 * refuses everything else rather than guessing — a schedule that silently means
 * something other than what was asked is worse than one that says it did not
 * understand.
 */

export interface ParsedSchedule {
  cron: string;
  /** Read back to the user so a misparse is visible before it runs for a month. */
  describes: string;
}

const DOW: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/** Named times of day, using the hours a person means by them. */
const NAMED_HOUR: Record<string, number> = {
  morning: 7,
  midday: 12,
  noon: 12,
  afternoon: 14,
  evening: 19,
  night: 22,
  midnight: 0,
};

function parseClock(text: string): number | null {
  // "at 7", "at 7am", "at 07:30", "at 7.30pm"
  const m = text.match(/\bat\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const meridiem = m[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  // Without am/pm, a small number in the evening sense is ambiguous; take it
  // literally rather than inventing an interpretation.
  return hour >= 0 && hour <= 23 ? hour : null;
}

function parseMinute(text: string): number {
  const m = text.match(/\bat\s+\d{1,2}[:.](\d{2})/);
  return m ? Number(m[1]) : 0;
}

export function parseSchedule(input: string): ParsedSchedule | null {
  const text = input.toLowerCase().trim();
  if (!text) return null;

  // Already a cron expression — pass it through rather than refusing it.
  if (/^(\S+\s+){4}\S+$/.test(text) && /[*\d]/.test(text[0] ?? '')) {
    return { cron: text, describes: `cron: ${text}` };
  }

  const minute = parseMinute(text);
  const clockHour = parseClock(text);

  // "every N minutes"
  const mins = text.match(/every\s+(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (mins) {
    const n = Number(mins[1]);
    if (n < 1 || n > 59) return null;
    return { cron: `*/${n} * * * *`, describes: `every ${n} minute${n === 1 ? '' : 's'}` };
  }

  // "every N hours"
  const hours = text.match(/every\s+(\d+)\s*(?:hours?|hrs?|h)\b/);
  if (hours) {
    const n = Number(hours[1]);
    if (n < 1 || n > 23) return null;
    return { cron: `0 */${n} * * *`, describes: `every ${n} hour${n === 1 ? '' : 's'}` };
  }

  // "every monday", "on fridays at 9"
  for (const [name, dow] of Object.entries(DOW)) {
    if (new RegExp(`\\b${name}s?\\b`).test(text)) {
      const hour = clockHour ?? NAMED_HOUR[Object.keys(NAMED_HOUR).find((k) => text.includes(k)) ?? ''] ?? 9;
      return {
        cron: `${minute} ${hour} * * ${dow}`,
        describes: `every ${name} at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      };
    }
  }

  // "every weekday", "on weekdays"
  if (/\bweekdays?\b/.test(text)) {
    const hour = clockHour ?? 9;
    return {
      cron: `${minute} ${hour} * * 1-5`,
      describes: `weekdays at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }

  // "every morning", "each night", "daily at 6"
  for (const [name, hour] of Object.entries(NAMED_HOUR)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) {
      const h = clockHour ?? hour;
      return {
        cron: `${minute} ${h} * * *`,
        describes: `every day at ${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      };
    }
  }

  if (/\b(daily|every day|each day)\b/.test(text)) {
    const hour = clockHour ?? 9;
    return {
      cron: `${minute} ${hour} * * *`,
      describes: `every day at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  }

  if (/\b(hourly|every hour)\b/.test(text)) {
    return { cron: `${minute} * * * *`, describes: `every hour at :${String(minute).padStart(2, '0')}` };
  }

  if (/\b(weekly|every week)\b/.test(text)) {
    const hour = clockHour ?? 9;
    return { cron: `${minute} ${hour} * * 1`, describes: `every Monday at ${String(hour).padStart(2, '0')}:00` };
  }

  // Understood nothing. Returning null is the honest answer; a default schedule
  // would run something at a time nobody chose.
  return null;
}
