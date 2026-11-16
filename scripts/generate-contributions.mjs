#!/usr/bin/env node
/**
 * Generate a self-hosted GitHub contribution calendar as an SVG.
 *
 * Data is read from the GitHub GraphQL API using the repository's
 * GITHUB_TOKEN (or a local GH_TOKEN). The script fails without writing
 * anything when the API is unavailable, so the previously committed SVG
 * remains in place as a fallback. No contribution data is ever mocked.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const LOGIN = process.env.GITHUB_LOGIN?.trim() || "krushna081";
const OUTPUT = resolve(process.env.OUTPUT_PATH || "assets/contributions.svg");
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const API_URL = "https://api.github.com/graphql";
const DAY_MS = 86_400_000;

const COLORS = {
  page: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  muted: "#8b949e",
  accent: "#57d68d",
  levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
};

const LEVEL_INDEX = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

function computeStreaks(days, todayIso) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));

  let longest = 0;
  let run = 0;
  for (const day of sorted) {
    if (day.count > 0) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  // A streak that is still alive is not broken by a zero-count "today"
  // until the day is over, so start from yesterday when needed.
  let index = sorted.length - 1;
  if (index >= 0 && sorted[index].date === todayIso && sorted[index].count === 0) {
    index -= 1;
  }

  let current = 0;
  while (index >= 0 && sorted[index].count > 0) {
    current += 1;
    index -= 1;
  }

  return { current, longest };
}

if (!TOKEN) {
  fail("GH_TOKEN (or GITHUB_TOKEN) is required. Refusing to generate a graph without real data.");
}

const now = new Date();
const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const fromUtc = new Date(todayUtc.getTime() - 365 * DAY_MS);
const fromIso = fromUtc.toISOString().slice(0, 10);
const toIso = todayUtc.toISOString().slice(0, 10);
const updatedLabel = `${now.toISOString().replace("T", " ").slice(0, 16)} UTC`;

const query = `
  query ContributionCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              contributionLevel
            }
          }
        }
      }
    }
  }
`;

let response;
try {
  response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${LOGIN}-profile-contribution-graph`,
    },
    body: JSON.stringify({
      query,
      variables: { login: LOGIN, from: fromUtc.toISOString(), to: todayUtc.toISOString() },
    }),
  });
} catch (error) {
  fail(`Could not reach the GitHub GraphQL API: ${error.message}`);
}

if (!response.ok) {
  const body = await response.text().catch(() => "");
  fail(`GitHub API request failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
}

const payload = await response.json().catch(() => null);
if (!payload) {
  fail("GitHub API returned a response that was not valid JSON.");
}
if (payload.errors?.length) {
  fail(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
}

const user = payload.data?.user;
const calendar = user?.contributionsCollection?.contributionCalendar;
const weeks = calendar?.weeks;

if (!user || !calendar || !Array.isArray(weeks) || weeks.length === 0) {
  fail(`No contribution calendar returned for "${LOGIN}".`);
}

const gridWeeks = weeks.slice(-53);
const allDays = gridWeeks.flatMap((week) =>
  (week.contributionDays ?? []).map((day) => ({
    date: day.date,
    count: Number(day.contributionCount) || 0,
    level: LEVEL_INDEX[String(day.contributionLevel).toUpperCase()] ?? 0,
  })),
);
const rangeDays = allDays.filter((day) => day.date >= fromIso && day.date <= toIso);

if (rangeDays.length === 0) {
  fail("Contribution calendar did not contain any days for the requested range.");
}

const total = Number(calendar.totalContributions) || rangeDays.reduce((sum, day) => sum + day.count, 0);
const { current: currentStreak, longest: longestStreak } = computeStreaks(rangeDays, toIso);

const WIDTH = 900;
const HEIGHT = 340;
const CELL = 12;
const STEP = 15;
const GRID_X = 76;
const GRID_Y = 186;
const GRID_WIDTH = gridWeeks.length * STEP;
const numberFormat = new Intl.NumberFormat("en-US");

const monthLabels = [];
let lastMonth = null;
for (const [weekIndex, week] of gridWeeks.entries()) {
  const firstOfMonth = (week.contributionDays ?? []).find((day) => day.date.endsWith("-01"));
  if (!firstOfMonth) continue;

  const monthIndex = Number(firstOfMonth.date.slice(5, 7)) - 1;
  if (monthIndex === lastMonth) continue;

  lastMonth = monthIndex;
  monthLabels.push({ x: GRID_X + weekIndex * STEP, label: MONTHS[monthIndex] });
}

const firstWeekDay = gridWeeks[0]?.contributionDays?.[0]?.date;
if (firstWeekDay && monthLabels.length > 0) {
  const firstMonth = Number(firstWeekDay.slice(5, 7)) - 1;
  const firstLabel = monthLabels[0];
  if (MONTHS[firstMonth] !== firstLabel.label && firstLabel.x - GRID_X >= 24) {
    monthLabels.unshift({ x: GRID_X, label: MONTHS[firstMonth] });
  }
}

const monthLabelMarkup = monthLabels
  .map(
    ({ x, label }) =>
      `<text x="${x}" y="174" fill="${COLORS.muted}" font-size="10.5">${label}</text>`,
  )
  .join("");

const weekdayLabels = [1, 3, 5]
  .map(
    (row) =>
      `<text x="${GRID_X - 12}" y="${GRID_Y + row * STEP + 10}" fill="${COLORS.muted}" font-size="9.5" text-anchor="end">${WEEKDAYS[row]}</text>`,
  )
  .join("");

const dayCells = gridWeeks
  .flatMap((week, weekIndex) =>
    (week.contributionDays ?? []).map((day) => {
      const count = Number(day.contributionCount) || 0;
      const level = LEVEL_INDEX[String(day.contributionLevel).toUpperCase()] ?? 0;
      const [year, month, date] = day.date.split("-").map(Number);
      const row = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
      const x = GRID_X + weekIndex * STEP;
      const y = GRID_Y + row * STEP;
      const tooltip = `${count} contribution${count === 1 ? "" : "s"} on ${formatDate(day.date)}`;

      return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="${COLORS.levels[level]}"><title>${tooltip}</title></rect>`;
    }),
  )
  .join("");

const legendSquares = COLORS.levels
  .map(
    (color, index) =>
      `<rect x="${735 + index * 16}" y="${308}" width="${CELL}" height="${CELL}" rx="2.5" fill="${color}" />`,
  )
  .join("");

const stats = [
  { x: 40, value: numberFormat.format(total), label: "CONTRIBUTIONS · LAST 12 MONTHS" },
  { x: 300, value: numberFormat.format(currentStreak), label: "CURRENT STREAK · DAYS" },
  { x: 560, value: numberFormat.format(longestStreak), label: "LONGEST STREAK · DAYS" },
]
  .map(
    ({ x, value, label }) =>
      `<text x="${x}" y="124" fill="${COLORS.accent}" font-size="30" font-weight="700">${value}</text>
       <text x="${x}" y="144" fill="${COLORS.muted}" font-size="10.5" letter-spacing="1.2">${label}</text>`,
  )
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" aria-label="GitHub contribution calendar for ${escapeXml(LOGIN)} over the last 12 months: ${total} contributions, current streak ${currentStreak} days, longest streak ${longestStreak} days.">
  <title>GitHub contribution activity for @${escapeXml(LOGIN)}</title>
  <desc>Last 12 months: ${total} contributions, current streak ${currentStreak} days, longest streak ${longestStreak} days. Source: GitHub GraphQL API. Updated ${escapeXml(updatedLabel)}.</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" rx="14" fill="${COLORS.page}" stroke="${COLORS.border}" />
  <rect x="40" y="32" width="4" height="20" rx="2" fill="${COLORS.accent}" />
  <text x="54" y="48" fill="${COLORS.text}" font-size="21" font-weight="700" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif">GitHub Contribution Activity</text>
  <text x="40" y="72" fill="${COLORS.muted}" font-size="12" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif">github.com/${escapeXml(LOGIN)} · last 12 months</text>
  <text x="860" y="48" fill="${COLORS.muted}" font-size="10.5" text-anchor="end" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif">Updated ${escapeXml(updatedLabel)}</text>
  <line x1="40" y1="90" x2="860" y2="90" stroke="${COLORS.border}" stroke-width="1" />
  ${stats}
  <line x1="270" y1="100" x2="270" y2="146" stroke="${COLORS.border}" />
  <line x1="530" y1="100" x2="530" y2="146" stroke="${COLORS.border}" />
  <line x1="40" y1="162" x2="860" y2="162" stroke="${COLORS.border}" />
  ${monthLabelMarkup}
  ${weekdayLabels}
  ${dayCells}
  <text x="40" y="318" fill="${COLORS.muted}" font-size="10.5" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif">Source: GitHub GraphQL API · auto-refreshed daily by GitHub Actions</text>
  <text x="723" y="318" fill="${COLORS.muted}" font-size="10.5" text-anchor="end" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif">Less</text>
  ${legendSquares}
  <text x="825" y="318" fill="${COLORS.muted}" font-size="10.5" font-family="'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif">More</text>
</svg>
`;

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${svg}\n`, "utf8");

console.log(
  `Generated ${OUTPUT} for @${LOGIN}: ${numberFormat.format(total)} contributions, ` +
    `${currentStreak}-day current streak, ${longestStreak}-day longest streak ` +
    `(${rangeDays.length} days, grid width ${GRID_WIDTH}px).`,
);
