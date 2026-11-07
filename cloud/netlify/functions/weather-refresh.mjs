// Runs every hour. Only the first run in each check window contacts Open-Meteo; the rest do nothing.
import { refreshHome } from "../../lib/weather.mjs";

export default async () => {
  const result = await refreshHome();
  console.log("weather refresh:", result.status);
};

export const config = { schedule: "@hourly" };
