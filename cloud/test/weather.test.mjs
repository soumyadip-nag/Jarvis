// Weather caching and fallbacks, with a fake clock and a fake Open-Meteo.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JARVIS_LOCAL_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-weather-"));
const { getWeather, refreshHome, windowOf } = await import("../lib/weather.mjs");
const { recentMessages } = await import("../lib/messages.mjs");

const IST = "Asia/Kolkata";
const at = (day, hour, minute = 0) => Date.parse(`2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+05:30`);

let calls, weatherCode, temperature, down;

function fakeForecast() {
  const days = ["2026-11-10", "2026-11-11", "2026-11-12"];
  const hours = days.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`));
  return {
    current: {
      weather_code: weatherCode, temperature_2m: temperature, apparent_temperature: temperature + 1,
      relative_humidity_2m: 70, precipitation: 0, wind_speed_10m: 10,
    },
    hourly: {
      time: hours,
      temperature_2m: hours.map(() => temperature),
      precipitation_probability: hours.map(() => 40),
      weather_code: hours.map(() => weatherCode),
    },
    daily: {
      time: days,
      weather_code: days.map(() => weatherCode),
      temperature_2m_max: days.map(() => temperature + 3),
      temperature_2m_min: days.map(() => temperature - 3),
      precipitation_probability_max: days.map(() => 40),
    },
  };
}

const realFetch = globalThis.fetch;
let nextLatitude = 40;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (down) throw new Error("The operation timed out");
  if (String(url).includes("geocoding")) {
    const name = decodeURIComponent(String(url).split("name=")[1]);
    if (name === "Nowhereville") return new Response(JSON.stringify({}));
    const latitude = name === "Kolkata" ? 22.57 : nextLatitude++;
    return new Response(JSON.stringify({ results: [{ name, country: "India", latitude, longitude: 88.36, timezone: IST }] }));
  }
  return new Response(JSON.stringify(fakeForecast()));
};
test.after(() => { globalThis.fetch = realFetch; });

beforeEach(() => {
  fs.rmSync(process.env.JARVIS_LOCAL_STORE, { recursive: true, force: true });
  fs.mkdirSync(process.env.JARVIS_LOCAL_STORE, { recursive: true });
  calls = [];
  weatherCode = 2;
  temperature = 25;
  down = false;
});

const setHome = (now = at(10, 7)) => getWeather({ location: "Kolkata", setHome: true, tz: IST, now });
const forecastCalls = () => calls.filter((c) => c.includes("/v1/forecast")).length;

test("with no home region it asks instead of guessing", async () => {
  const r = await getWeather({ tz: IST, now: at(10, 7) });
  assert.equal(r.status, "ask_location");
  assert.equal(calls.length, 0);
});

test("a question within 15 minutes of a reading reuses it", async () => {
  assert.equal((await setHome()).status, "live");
  const used = calls.length;
  const r = await getWeather({ tz: IST, now: at(10, 7, 14) });
  assert.equal(r.status, "stored");
  assert.match(r.text, /Kolkata/);
  assert.equal(calls.length, used);
});

test("a question after 15 minutes checks live, with no daily cap", async () => {
  await setHome(at(10, 6));
  for (let minutes = 20; minutes <= 20 * 40; minutes += 20) {
    const r = await getWeather({ tz: IST, now: at(10, 6) + minutes * 60_000 });
    assert.equal(r.status, "live");
  }
  assert.equal(forecastCalls(), 41);
});

test("other cities have no limit, and a place is only looked up once", async () => {
  await setHome();
  for (let i = 0; i < 15; i++) assert.equal((await getWeather({ location: `City${i}`, tz: IST, now: at(10, 8) })).status, "live");
  assert.equal(forecastCalls(), 16);
  const lookups = calls.filter((c) => c.includes("geocoding")).length;
  await getWeather({ location: "City3", tz: IST, now: at(10, 9) });
  assert.equal(calls.filter((c) => c.includes("geocoding")).length, lookups);
});

test("asking by name for the home city uses the same report", async () => {
  await setHome();
  const used = calls.length;
  assert.equal((await getWeather({ location: "Kolkata", tz: IST, now: at(10, 7, 5) })).status, "stored");
  assert.equal(calls.length, used);
});

test("hours before 6am belong to the previous day's 10pm window", () => {
  assert.equal(windowOf(at(11, 3), IST), windowOf(at(10, 23), IST));
  assert.notEqual(windowOf(at(11, 6), IST), windowOf(at(11, 3), IST));
});

test("the hourly job makes at most 5 checks in a day", async () => {
  await setHome(at(10, 6));
  for (let hour = 6; hour <= 23; hour++) await refreshHome(at(10, hour));
  assert.equal(forecastCalls(), 5);
});

test("the hourly job does nothing without a home region", async () => {
  assert.equal((await refreshHome(at(10, 7))).status, "no_home");
  assert.equal(calls.length, 0);
});

test("if a check times out it reports the last reading, clearly as old", async () => {
  weatherCode = 63; // rain
  await setHome(at(10, 7));
  down = true;
  const r = await getWeather({ tz: IST, now: at(10, 11) });
  assert.equal(r.status, "stale");
  assert.match(r.text, /the weather service did not respond/);
  assert.match(r.text, /last time you checked/);
  assert.match(r.text, /rain, 25°C/);
  assert.match(r.text, /7:00/);
});

test("a failed check isn't retried for 5 minutes, then is", async () => {
  await setHome(at(10, 7));
  down = true;
  await getWeather({ tz: IST, now: at(10, 11) });
  const used = calls.length;
  await getWeather({ tz: IST, now: at(10, 11, 3) });
  assert.equal(calls.length, used);
  down = false;
  assert.equal((await getWeather({ tz: IST, now: at(10, 11, 6) })).status, "live");
});

test("with no earlier reading a failure says so rather than inventing weather", async () => {
  await setHome(at(10, 7));
  down = true;
  const r = await getWeather({ location: "Pune", tz: IST, now: at(10, 7, 10) });
  assert.equal(r.status, "unavailable");
  assert.match(r.text, /not been looked up/);
});

test("a major change found by the hourly job posts one message to the shared chat", async () => {
  await setHome(at(10, 7));
  await refreshHome(at(10, 10)); // no change
  assert.equal((await recentMessages()).length, 0);
  weatherCode = 95;
  await refreshHome(at(10, 14));
  await refreshHome(at(10, 15)); // same window: no call, no repeat message
  const messages = await recentMessages();
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /thunderstorm has started/);
  assert.equal(messages[0].role, "assistant");
});

test("a large temperature swing counts as major; a small one doesn't", async () => {
  await setHome(at(10, 7));
  temperature = 28;
  assert.equal((await getWeather({ tz: IST, now: at(10, 11) })).report.change, null);
  temperature = 19;
  const r = await getWeather({ tz: IST, now: at(10, 15) });
  assert.match(r.report.change, /dropped 9°C/);
  assert.match(r.text, /Major change/);
});

test("an unknown place is reported as unknown", async () => {
  const r = await getWeather({ location: "Nowhereville", tz: IST, now: at(10, 7) });
  assert.equal(r.status, "not_found");
});
