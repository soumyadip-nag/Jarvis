// Regional weather from Open-Meteo (free for private, non-commercial use; no key), remembered in the
// shared store. Data licence: CC BY 4.0, so the app credits Open-Meteo in its settings screen.
//
// * The hourly job checks the home region at most 5 times a day: about 6am, 10am, 2pm, 6pm and 10pm
//   local time. That keeps a report ready and is how major changes get noticed.
// * A question uses a reading under 15 minutes old, otherwise it checks live.
// * If a check fails, the last stored report is used and described as old. Open-Meteo gives no uptime
//   guarantee and can rate-limit shared cloud addresses like Netlify's, so this path matters.
import crypto from "node:crypto";
import { store } from "./store.mjs";
import { addMessage } from "./messages.mjs";

const WINDOW_STARTS = [6, 10, 14, 18, 22];
const TIMEOUT_MS = 6000;
const FRESH_MS = 15 * 60_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const MAJOR_TEMP_CHANGE = 8; // °C
const STRONG_WIND = 50; // km/h

const CONDITIONS = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail",
};
const conditionOf = (code) => CONDITIONS[code] || "unknown conditions";

function kindOf(code) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  return "dry"; // clear, cloudy and fog
}

// ───────── time ─────────
function localParts(ms, tz) {
  const read = (timeZone) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  };
  let p;
  try { p = read(tz || "UTC"); } catch { p = read("UTC"); }
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: p.minute };
}

/** Which check window a moment is in. The hours before 6am belong to the previous day's 10pm window. */
export function windowOf(ms, tz) {
  const { date, hour } = localParts(ms, tz);
  if (hour < WINDOW_STARTS[0]) {
    const previous = new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
    return `${previous}#${WINDOW_STARTS.length - 1}`;
  }
  let slot = 0;
  WINDOW_STARTS.forEach((start, i) => { if (hour >= start) slot = i; });
  return `${date}#${slot}`;
}

function when(ms, tz) {
  try {
    return new Date(ms).toLocaleString("en-GB", {
      timeZone: tz || "UTC", weekday: "long", hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  return res.json();
}

// ───────── places ─────────
const hash = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
const placeKey = (place) => `${place.latitude.toFixed(2)}_${place.longitude.toFixed(2)}`;

/** Find a place by name. Names already looked up are remembered. */
async function findPlace(name, tz) {
  const key = `weather/place/${hash(name.trim().toLowerCase())}`;
  const known = await store().get(key);
  if (known) return { place: known };
  let data;
  try {
    data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name.trim())}`);
  } catch {
    return { problem: "failed" };
  }
  const hit = data.results?.[0];
  if (!hit) return { problem: "not_found" };
  const place = {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
    latitude: hit.latitude,
    longitude: hit.longitude,
    tz: hit.timezone || tz || "UTC",
  };
  await store().setJSON(key, place);
  return { place };
}

// ───────── reports ─────────
async function fetchReport(place, now) {
  const url = "https://api.open-meteo.com/v1/forecast?timezone=auto&forecast_days=3&wind_speed_unit=kmh" +
    `&latitude=${place.latitude}&longitude=${place.longitude}` +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m" +
    "&hourly=temperature_2m,precipitation_probability,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max";
  const d = await getJson(url);
  return {
    place,
    fetchedAt: now,
    window: windowOf(now, place.tz),
    current: {
      code: d.current.weather_code,
      temp: d.current.temperature_2m,
      feels: d.current.apparent_temperature,
      humidity: d.current.relative_humidity_2m,
      wind: d.current.wind_speed_10m,
    },
    hourly: d.hourly.time.map((time, i) => ({
      time,
      temp: d.hourly.temperature_2m[i],
      rain: d.hourly.precipitation_probability[i],
      code: d.hourly.weather_code[i],
    })),
    daily: d.daily.time.map((date, i) => ({
      date,
      code: d.daily.weather_code[i],
      max: d.daily.temperature_2m_max[i],
      min: d.daily.temperature_2m_min[i],
      rain: d.daily.precipitation_probability_max[i],
    })),
  };
}

/** A sentence describing a major change between two readings, or null. */
export function majorChange(previous, next) {
  if (!previous || next.fetchedAt - previous.fetchedAt > DAY_MS) return null;
  const before = previous.current, now = next.current;
  const changes = [];
  const was = kindOf(before.code), is = kindOf(now.code);
  if (was !== is) {
    changes.push(is === "dry"
      ? `the ${was === "storm" ? "storm" : was} has stopped`
      : `${conditionOf(now.code)} has started`);
  }
  const difference = now.temp - before.temp;
  if (Math.abs(difference) >= MAJOR_TEMP_CHANGE) {
    changes.push(`the temperature has ${difference > 0 ? "risen" : "dropped"} ${Math.abs(Math.round(difference))}°C`);
  }
  if (now.wind >= STRONG_WIND && before.wind < STRONG_WIND) changes.push(`winds have reached ${Math.round(now.wind)} km/h`);
  return changes.length ? changes.join(" and ") : null;
}

const summary = (report) => {
  const c = report.current;
  return `${conditionOf(c.code)}, ${Math.round(c.temp)}°C (feels like ${Math.round(c.feels)}°C), ` +
    `humidity ${c.humidity}%, wind ${Math.round(c.wind)} km/h`;
};

function forecastLines(report, now) {
  const tz = report.place.tz;
  const { date, hour } = localParts(now, tz);
  const thisHour = `${date}T${String(hour).padStart(2, "0")}:00`;
  const lines = [];
  const start = report.hourly.findIndex((h) => h.time === thisHour);
  if (start >= 0) {
    const h = report.hourly[start];
    lines.push(`Forecast for this hour: ${conditionOf(h.code)}, ${Math.round(h.temp)}°C.`);
    const wettest = report.hourly.slice(start, start + 12).reduce((a, b) => ((b.rain ?? 0) > (a.rain ?? 0) ? b : a));
    if ((wettest.rain ?? 0) >= 30) {
      lines.push(`Highest chance of rain in the next 12 hours: ${wettest.rain}% around ${wettest.time.slice(11)}.`);
    }
  }
  const labels = ["Today", "Tomorrow", "Day after tomorrow"];
  const today = report.daily.findIndex((d) => d.date === date);
  if (today >= 0) {
    report.daily.slice(today).forEach((d, i) => {
      lines.push(`${labels[i]}: ${conditionOf(d.code)}, ${Math.round(d.min)}-${Math.round(d.max)}°C, ${d.rain ?? 0}% chance of rain.`);
    });
  }
  return lines;
}

function describe(report, now, reason) {
  const tz = report.place.tz;
  const checkedAt = when(report.fetchedAt, tz);
  if (reason) {
    return [
      `Live weather is unavailable (${reason}). Tell the user this plainly, and say that the last time you checked ` +
        `${report.place.name}, at ${checkedAt}, it was ${summary(report)}. Do not present this as current.`,
      ...forecastLines(report, now),
    ].join("\n");
  }
  return [
    `Weather for ${report.place.name}, checked at ${checkedAt}: ${summary(report)}.`,
    ...forecastLines(report, now),
    ...(report.change ? [`Major change since the previous check: ${report.change}.`] : []),
  ].join("\n");
}

const UNAVAILABLE = "the weather service did not respond";

/**
 * Get the weather for a place, or the home region if none is named.
 * A question accepts a reading under 15 minutes old; the hourly job (`scheduled`) accepts anything
 * from the current check window, so it makes at most 5 checks a day.
 * Returns { status: "ask_location" | "not_found" | "live" | "stored" | "stale" | "unavailable", text, report? }.
 */
export async function getWeather({ location, setHome = false, tz, now = Date.now(), scheduled = false } = {}) {
  const s = store();
  const home = await s.get("weather/home");
  const name = (location || "").trim();

  if (!name && !home) {
    return {
      status: "ask_location",
      text: "No home region is saved yet. Ask the user which city they are in, then call get_weather with that location and set_as_home true.",
    };
  }

  let place = home;
  if (name) {
    const found = await findPlace(name, home?.tz || tz);
    if (found.problem === "not_found") return { status: "not_found", text: `No place called "${name}" could be found. Ask the user to rephrase it.` };
    if (found.problem) {
      return { status: "unavailable", text: `Live weather is unavailable (${UNAVAILABLE}) and "${name}" has not been looked up before, so there is no earlier reading. Say so plainly.` };
    }
    place = found.place;
  }
  if (setHome) await s.setJSON("weather/home", place);

  const reportKey = `weather/report/${placeKey(place)}`;
  const failKey = `weather/failure/${placeKey(place)}`;
  const previous = await s.get(reportKey);

  const recentEnough = previous && (scheduled
    ? previous.window === windowOf(now, place.tz)
    : now - previous.fetchedAt < FRESH_MS);
  if (recentEnough) return { status: "stored", text: describe(previous, now), report: previous };

  const lastFailure = await s.get(failKey);
  if (!lastFailure || now - lastFailure.at >= RETRY_AFTER_FAILURE_MS) { // a retry would only add a long wait
    try {
      const report = await fetchReport(place, now);
      report.change = majorChange(previous, report);
      await s.setJSON(reportKey, report);
      await s.delete(failKey);
      return { status: "live", text: describe(report, now), report };
    } catch (e) {
      console.error("weather check failed:", e.message);
      await s.setJSON(failKey, { at: now });
    }
  }

  if (previous) return { status: "stale", text: describe(previous, now, UNAVAILABLE), report: previous };
  return { status: "unavailable", text: `Live weather is unavailable (${UNAVAILABLE}) and there is no earlier reading for ${place.name}. Say so plainly.` };
}

/** Run by the hourly scheduled function: keeps the home report current and flags major changes. */
export async function refreshHome(now = Date.now()) {
  const home = await store().get("weather/home");
  if (!home) return { status: "no_home" };
  const result = await getWeather({ tz: home.tz, now, scheduled: true });
  if (result.status === "live" && result.report.change) {
    await addMessage({
      role: "assistant",
      device: "cloud",
      content: `Weather update for ${home.name}: ${result.report.change}. It is now ${summary(result.report)}.`,
    });
  }
  return { status: result.status };
}
