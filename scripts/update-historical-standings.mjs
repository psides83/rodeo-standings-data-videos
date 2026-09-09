import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx/standings';
const ATHLETE_URL = 'https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx/athlete';
const DEFAULT_EVENTS = [
  'AA',
  'BB',
  'SB',
  'BR',
  'SR',
  'TD',
  'SW',
  'GB',
  'TRHD',
  'TRHL',
  'LB',
];
const DEFAULT_DELAY_MS = 2500;
const DEFAULT_ATHLETE_DELAY_MS = 750;
const TIME_ZONE = 'America/Denver';
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.join(rootDir, 'data', 'historical-standings');

const args = new Set(process.argv.slice(2));

function getMountainParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function isLastMountainDayAtEleven(date = new Date()) {
  const parts = getMountainParts(date);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return day === lastDay && hour === 23;
}

function currentMountainYearMonth(date = new Date()) {
  const parts = getMountainParts(date);
  return {
    year: Number(parts.year),
    monthKey: monthLabelForKey(`${parts.year}-${parts.month}`),
  };
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

async function readCsv(filePath) {
  try {
    const text = await readFile(filePath, 'utf8');
    const rows = parseCsv(text);
    if (!rows.length) return { header: [], rows: [] };

    return {
      header: rows[0],
      rows: rows.slice(1),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { header: [], rows: [] };
    throw error;
  }
}

function writeCsv({ header, rows }) {
  return `${[header, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\n')}\n`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEvents() {
  const configured = process.env.EVENTS?.trim();
  if (!configured) return DEFAULT_EVENTS;

  return configured
    .split(',')
    .map((event) => event.trim().toUpperCase())
    .filter(Boolean);
}

function imageUrl(value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://prorodeo.com${value.startsWith('/') ? value : `/${value}`}`;
}

function athleteName(row) {
  return [row.FirstName, row.LastName]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

async function fetchStandings({ year, event }) {
  const url = new URL(BASE_URL);
  url.searchParams.set('year', String(year));
  url.searchParams.set('type', 'world');
  url.searchParams.set('id', '');
  url.searchParams.set('event', event);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for event ${event}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`API error for event ${event}: ${payload.error}`);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error(`Unexpected response for event ${event}: missing data array`);
  }

  return payload.data;
}

async function fetchAthleteBio(athleteID) {
  const url = new URL(ATHLETE_URL);
  url.searchParams.set('id', athleteID);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for athlete ${athleteID}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(`API error for athlete ${athleteID}: ${payload.error}`);
  }
  if (!payload.data || typeof payload.data !== 'object') {
    throw new Error(`Unexpected response for athlete ${athleteID}: missing data object`);
  }

  return payload.data;
}

function outputPathForEvent(event, year) {
  return path.join(outputDir, `${event.toLowerCase()}-standings-${year}.csv`);
}

function legacyOutputPathForEvent(event) {
  return path.join(outputDir, `${event.toLowerCase()}.csv`);
}

function monthLabelForKey(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return monthKey;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex >= MONTH_NAMES.length) return monthKey;

  return `${MONTH_NAMES[monthIndex]} ${year}`;
}

function monthKeyForColumn(column) {
  const legacyMatch = /^(\d{4})-(\d{2})$/.exec(column);
  if (legacyMatch) return column;

  const labelMatch = /^([A-Z][a-z]{2}) (\d{4})$/.exec(column);
  if (!labelMatch) return '';

  const monthIndex = MONTH_NAMES.indexOf(labelMatch[1]);
  if (monthIndex === -1) return '';

  return `${labelMatch[2]}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function normalizeMonthColumn(column) {
  return monthLabelForKey(monthKeyForColumn(column) || column);
}

function monthColumns(header) {
  return header.filter((column) => monthKeyForColumn(column));
}

function monthKeyForIndex(year, monthIndex) {
  return monthLabelForKey(`${year}-${String(monthIndex + 1).padStart(2, '0')}`);
}

function seasonMonthColumns(year) {
  return [
    ...[9, 10, 11].map((monthIndex) => monthKeyForIndex(year - 1, monthIndex)),
    ...Array.from({ length: 9 }, (_, monthIndex) => monthKeyForIndex(year, monthIndex)),
  ];
}

function latestPriorMonthValue(row, header, monthKey) {
  const months = monthColumns(header)
    .filter((column) => monthKeyForColumn(column) < monthKeyForColumn(monthKey))
    .sort((a, b) => monthKeyForColumn(a).localeCompare(monthKeyForColumn(b)));

  for (let index = months.length - 1; index >= 0; index -= 1) {
    const value = row[header.indexOf(months[index])];
    if (value !== '') return value;
  }

  return '';
}

function dateMonthKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return monthLabelForKey(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
}

function toMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return String(Math.round(number * 100) / 100);
}

function roundedMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function standingsEarnings(standing) {
  const value = Number(standing.Earnings);
  return Number.isFinite(value) ? value : 0;
}

function isNfrEntry(entry) {
  return /\bnational finals rodeo\b/i.test(String(entry.RodeoName || ''));
}

function sumPayoffsByMonth({ athleteBio, event, year, backfillColumns }) {
  const totals = new Map();
  const validMonths = new Set(backfillColumns);
  const entries = [
    ...(Array.isArray(athleteBio.Averages) ? athleteBio.Averages : []),
    ...(Array.isArray(athleteBio.Results) ? athleteBio.Results : []),
  ];

  for (const entry of entries) {
    if (event !== 'AA' && String(entry.EventType || '').toUpperCase() !== event) continue;
    if (Number(entry.SeasonYear) !== year) continue;
    if (isNfrEntry(entry)) continue;

    const monthKey = dateMonthKey(entry.EndDate || entry.StartDate);
    if (!validMonths.has(monthKey)) continue;

    const payoff = Number(entry.Payoff);
    if (!Number.isFinite(payoff)) continue;

    totals.set(monthKey, (totals.get(monthKey) || 0) + payoff);
  }

  return totals;
}

function cumulativeMonthlyTotals(monthlyTotals, backfillColumns) {
  const cumulativeTotals = new Map();
  let runningTotal = 0;

  for (const column of backfillColumns) {
    runningTotal += monthlyTotals.get(column) || 0;
    cumulativeTotals.set(column, runningTotal);
  }

  return cumulativeTotals;
}

function adjustMonthlyTotalsToStandings(monthlyTotals, standingTotal, monthColumnsToAdjust = []) {
  const totalPayoff = [...monthlyTotals.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(totalPayoff - standingTotal) <= 0.005) return monthlyTotals;

  const adjusted = new Map(monthlyTotals);
  const activeMonths = [...adjusted.entries()]
    .filter(([, value]) => value > 0)
    .map(([month]) => month);

  if (totalPayoff < standingTotal) {
    const monthsToAdjust = activeMonths.length ? activeMonths : monthColumnsToAdjust;
    if (!monthsToAdjust.length) return adjusted;
    const perMonthAdjustment = (standingTotal - totalPayoff) / monthsToAdjust.length;

    for (const month of monthsToAdjust) {
      adjusted.set(month, (adjusted.get(month) || 0) + perMonthAdjustment);
    }

    return adjusted;
  }

  let remainingDifference = totalPayoff - standingTotal;
  let adjustableMonths = activeMonths;

  while (remainingDifference > 0.005 && adjustableMonths.length) {
    const perMonthAdjustment = remainingDifference / adjustableMonths.length;
    const nextAdjustableMonths = [];

    for (const month of adjustableMonths) {
      const currentValue = adjusted.get(month);
      const adjustment = Math.min(currentValue, perMonthAdjustment);
      const nextValue = currentValue - adjustment;
      adjusted.set(month, nextValue);
      remainingDifference -= adjustment;

      if (nextValue > 0.005) {
        nextAdjustableMonths.push(month);
      }
    }

    adjustableMonths = nextAdjustableMonths;
  }

  return adjusted;
}

function reorderHeaderForBackfill(header, year) {
  const baseHeader = ['athleteID', 'Name', 'imageURL'];
  const otherColumns = header.filter(
    (column) => !baseHeader.includes(column) && !monthColumns([column]).length && column !== 'event',
  );

  return [...baseHeader, ...seasonMonthColumns(year), ...otherColumns];
}

function uniqueColumns(columns) {
  return [...new Set(columns)];
}

async function main() {
  if (args.has('--scheduled') && !isLastMountainDayAtEleven()) {
    console.log('Not the last day of the month at 11 pm Mountain Time. Skipping.');
    return;
  }

  const { year: mountainYear, monthKey } = currentMountainYearMonth();
  const year = Number(process.env.STANDINGS_YEAR || mountainYear);
  const events = normalizeEvents();
  const delayMs = Number(process.env.REQUEST_DELAY_MS || DEFAULT_DELAY_MS);
  const backfillMonths = args.has('--backfill-months') || process.env.BACKFILL_MONTHS === '1';
  const backfillColumns = seasonMonthColumns(year);
  const athleteDelayMs = Number(process.env.ATHLETE_REQUEST_DELAY_MS || DEFAULT_ATHLETE_DELAY_MS);
  const athleteLimit = Number(process.env.BACKFILL_ATHLETE_LIMIT || 0);
  const dryRun = args.has('--dry-run') || process.env.DRY_RUN === '1';

  await mkdir(outputDir, { recursive: true });

  for (const [index, event] of events.entries()) {
    console.log(`Fetching ${event} standings for ${year}`);
    const standings = await fetchStandings({ year, event });
    if (!standings.length) {
      console.warn(`No standings returned for ${event} in ${year}`);
    }

    const filePath = outputPathForEvent(event, year);
    let existing = await readCsv(filePath);
    if (!existing.header.length) {
      existing = await readCsv(legacyOutputPathForEvent(event));
    }
    const baseHeader = ['athleteID', 'Name', 'imageURL'];
    let header = existing.header.length
      ? uniqueColumns(existing.header.map(normalizeMonthColumn).filter((column) => column !== 'event'))
      : [...baseHeader];
    for (const column of baseHeader) {
      if (!header.includes(column)) header.push(column);
    }
    if (backfillMonths) {
      header = reorderHeaderForBackfill(header, year);
    } else if (!header.includes(monthKey)) {
      header.push(monthKey);
    }

    const indexes = Object.fromEntries(header.map((column, index) => [column, index]));
    const rowsByAthlete = new Map();
    const existingHeader = existing.header.map(normalizeMonthColumn);

    for (const row of existing.rows) {
      const normalized = Array.from({ length: header.length }, (_, columnIndex) => {
        const oldIndex = existingHeader.indexOf(header[columnIndex]);
        return oldIndex === -1 ? '' : row[oldIndex] ?? '';
      });
      if (normalized[indexes.athleteID]) {
        if (!normalized[indexes[monthKey]]) {
          normalized[indexes[monthKey]] = latestPriorMonthValue(normalized, header, monthKey);
        }
        rowsByAthlete.set(normalized[indexes.athleteID], normalized);
      }
    }

    const standingsToProcess = athleteLimit > 0 ? standings.slice(0, athleteLimit) : standings;
    for (const [standingIndex, standing] of standingsToProcess.entries()) {
      const athleteID = String(standing.ContestantId ?? '').trim();
      if (!athleteID) continue;

      const row = rowsByAthlete.get(athleteID) || Array.from({ length: header.length }, () => '');
      row[indexes.athleteID] = athleteID;
      row[indexes.Name] = athleteName(standing);
      row[indexes.imageURL] = imageUrl(standing.SidearmPhotoUrl);
      if (backfillMonths) {
        const athleteBio = await fetchAthleteBio(athleteID);
        const monthlyTotals = sumPayoffsByMonth({
          athleteBio,
          event,
          year,
          backfillColumns,
        });
        const rawTotal = [...monthlyTotals.values()].reduce((sum, value) => sum + value, 0);
        const standingTotal = standingsEarnings(standing);
        const adjustedTotals = adjustMonthlyTotalsToStandings(monthlyTotals, standingTotal, backfillColumns);
        const adjustedTotal = [...adjustedTotals.values()].reduce((sum, value) => sum + value, 0);
        const cumulativeTotals = cumulativeMonthlyTotals(adjustedTotals, backfillColumns);

        for (const column of backfillColumns) {
          row[indexes[column]] = cumulativeTotals.has(column) ? toMoney(cumulativeTotals.get(column)) : '';
        }

        if (dryRun) {
          console.log(
            `Backfill ${event} ${athleteID}: raw=${roundedMoney(rawTotal)} standings=${roundedMoney(standingTotal)} adjusted=${roundedMoney(adjustedTotal)}`,
          );
        }

        if (standingIndex < standingsToProcess.length - 1 && athleteDelayMs > 0) {
          await sleep(athleteDelayMs);
        }
      } else {
        row[indexes[monthKey]] = standing.Earnings == null ? '' : String(standing.Earnings);
      }
      rowsByAthlete.set(athleteID, row);
    }

    const rows = [...rowsByAthlete.values()].sort((a, b) =>
      a[indexes.Name].localeCompare(b[indexes.Name]),
    );

    if (dryRun) {
      console.log(`Dry run: would write ${rows.length} rows to ${filePath}`);
      console.log(writeCsv({ header, rows: rows.slice(0, 5) }));
    } else {
      await writeFile(filePath, writeCsv({ header, rows }), 'utf8');
      console.log(`Wrote ${rows.length} rows to ${filePath}`);
    }

    if (index < events.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
