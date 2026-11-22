// Local clock wording shared by the retry and error sentences ("4:30 PM", "Nov 19").
//
// The time zone is a parameter (an IANA name; `undefined` is the zone of this computer) so that
// tests are deterministic. `Intl` parts are assembled by hand: the formatted string of newer
// ICU versions puts a narrow no-break space before "PM", which would not match the sentences.

/**
 * @typedef {object} LocalTime
 * @property {string} time "4:30 PM".
 * @property {string} date "Nov 19".
 * @property {string} day "2026-11-19", for comparing days.
 */

/** @type {Map<string, Intl.DateTimeFormat>} */
const formats = new Map();

/**
 * @param {string | undefined} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatter(timeZone) {
  const key = timeZone ?? "";
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      ...(timeZone === undefined ? {} : { timeZone }),
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    formats.set(key, format);
  }
  return format;
}

/**
 * The wall clock reading of an instant in a time zone.
 * @param {number} ms Milliseconds since 1970.
 * @param {string} [timeZone]
 * @returns {LocalTime}
 */
export function localTime(ms, timeZone) {
  /** @type {Record<string, string>} */
  const parts = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  const { year, month, day, hour, minute, dayPeriod } = parts;
  return {
    time: `${hour}:${minute} ${(dayPeriod ?? "").toUpperCase()}`,
    date: `${month} ${day}`,
    day: `${year}-${month}-${day}`,
  };
}
