import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx/standings';
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
const TIME_ZONE = 'America/Denver';

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
    monthKey: `${parts.year}-${parts.month}`,
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

function outputPathForEvent(event, year) {
  return path.join(outputDir, `${event.toLowerCase()}-standings-${year}.csv`);
}

function legacyOutputPathForEvent(event) {
  return path.join(outputDir, `${event.toLowerCase()}.csv`);
}

function monthColumns(header) {
  return header.filter((column) => /^\d{4}-\d{2}$/.test(column));
}

function latestPriorMonthValue(row, header, monthKey) {
  const months = monthColumns(header)
    .filter((column) => column < monthKey)
    .sort();

  for (let index = months.length - 1; index >= 0; index -= 1) {
    const value = row[header.indexOf(months[index])];
    if (value !== '') return value;
  }

  return '';
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
    const header = existing.header.length
      ? existing.header.filter((column) => column !== 'event')
      : [...baseHeader];
    for (const column of baseHeader) {
      if (!header.includes(column)) header.push(column);
    }
    if (!header.includes(monthKey)) header.push(monthKey);

    const indexes = Object.fromEntries(header.map((column, index) => [column, index]));
    const rowsByAthlete = new Map();

    for (const row of existing.rows) {
      const normalized = Array.from({ length: header.length }, (_, columnIndex) => {
        const oldIndex = existing.header.indexOf(header[columnIndex]);
        return oldIndex === -1 ? '' : row[oldIndex] ?? '';
      });
      if (normalized[indexes.athleteID]) {
        if (!normalized[indexes[monthKey]]) {
          normalized[indexes[monthKey]] = latestPriorMonthValue(normalized, header, monthKey);
        }
        rowsByAthlete.set(normalized[indexes.athleteID], normalized);
      }
    }

    for (const standing of standings) {
      const athleteID = String(standing.ContestantId ?? '').trim();
      if (!athleteID) continue;

      const row = rowsByAthlete.get(athleteID) || Array.from({ length: header.length }, () => '');
      row[indexes.athleteID] = athleteID;
      row[indexes.Name] = athleteName(standing);
      row[indexes.imageURL] = imageUrl(standing.SidearmPhotoUrl);
      row[indexes[monthKey]] = standing.Earnings == null ? '' : String(standing.Earnings);
      rowsByAthlete.set(athleteID, row);
    }

    const rows = [...rowsByAthlete.values()].sort((a, b) =>
      a[indexes.Name].localeCompare(b[indexes.Name]),
    );

    await writeFile(filePath, writeCsv({ header, rows }), 'utf8');
    console.log(`Wrote ${rows.length} rows to ${filePath}`);

    if (index < events.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
