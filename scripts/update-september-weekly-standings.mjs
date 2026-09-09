import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = 'https://d1kfpvgfupbmyo.cloudfront.net/services/pro_rodeo.ashx/standings';
const PHOTO_BASE_URL = 'https://d1kfpvgfupbmyo.cloudfront.net/';
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
const SCHEDULED_YEAR = 2026;
const SCHEDULED_MONTH = '09';
const SCHEDULED_DAYS = new Set(['14', '21', '28']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outputDir = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.join(rootDir, 'data', 'september-weekly-standings');

const args = new Set(process.argv.slice(2));

function runDate() {
  return process.env.RUN_DATE ? new Date(process.env.RUN_DATE) : new Date();
}

function getMountainParts(date = runDate()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function isScheduledSeptemberMonday(date = runDate()) {
  const parts = getMountainParts(date);

  return (
    Number(parts.year) === SCHEDULED_YEAR &&
    parts.month === SCHEDULED_MONTH &&
    SCHEDULED_DAYS.has(parts.day) &&
    parts.weekday === 'Mon' &&
    Number(parts.hour) === 6
  );
}

function currentMountainRun({ date = runDate(), scheduled = false } = {}) {
  const parts = getMountainParts(date);
  return {
    year: Number(process.env.STANDINGS_YEAR || parts.year),
    columnKey: scheduled ? `${parts.year}-${parts.month}-${parts.day}` : manualColumnKey(parts),
  };
}

function manualColumnKey(parts) {
  if (process.env.COLUMN_KEY) return process.env.COLUMN_KEY;
  return `${parts.year}-${parts.month}-${parts.day}`;
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
  const text = String(value || '').trim();
  if (!text) return '';

  try {
    const url = new URL(text);
    const imagePath = url.pathname.replace(/^\/prorodeo\.com\/+/, '').replace(/^\/+/, '');
    return `${PHOTO_BASE_URL}${imagePath}${url.search}`;
  } catch {
    return `${PHOTO_BASE_URL}${text.replace(/^\/+/, '')}`;
  }
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
  return path.join(outputDir, `${event.toLowerCase()}-weekly-standings-${year}.csv`);
}

function collectionColumns(header) {
  return header.filter((column) => /^\d{4}-\d{2}-\d{2}$/.test(column));
}

function latestPriorCollectionValue(row, header, columnKey) {
  const columns = collectionColumns(header)
    .filter((column) => column < columnKey)
    .sort();

  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const value = row[header.indexOf(columns[index])];
    if (value !== '') return value;
  }

  return '';
}

async function main() {
  const scheduled = args.has('--scheduled');
  if (scheduled && !isScheduledSeptemberMonday()) {
    console.log('Not a remaining September 2026 Monday at 6 am Mountain Time. Skipping.');
    return;
  }

  const { year, columnKey } = currentMountainRun({ scheduled });
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
    const existing = await readCsv(filePath);
    const baseHeader = ['athleteID', 'Name', 'imageURL'];
    const header = existing.header.length ? [...existing.header] : [...baseHeader];
    for (const column of baseHeader) {
      if (!header.includes(column)) header.push(column);
    }
    if (!header.includes(columnKey)) header.push(columnKey);

    const indexes = Object.fromEntries(header.map((column, index) => [column, index]));
    const rowsByAthlete = new Map();

    for (const row of existing.rows) {
      const normalized = Array.from({ length: header.length }, (_, columnIndex) => {
        const oldIndex = existing.header.indexOf(header[columnIndex]);
        return oldIndex === -1 ? '' : row[oldIndex] ?? '';
      });
      if (normalized[indexes.athleteID]) {
        if (!normalized[indexes[columnKey]]) {
          normalized[indexes[columnKey]] = latestPriorCollectionValue(normalized, header, columnKey);
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
      row[indexes[columnKey]] = standing.Earnings == null ? '' : String(standing.Earnings);
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
