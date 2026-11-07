// Runs every hour. Only the first run in each check window contacts Open-Meteo; the rest do nothing.
import { refreshHome } from "../../lib/weather.mjs";
import { allUsers, runAsUser } from "../../lib/users.mjs";

export default async () => {
  for (const user of allUsers()) {
    try {
      const result = await runAsUser(user, () => refreshHome());
      console.log("weather refresh:", result.status);
    } catch (e) {
      console.log("weather refresh failed:", e.message);
    }
  }
};

export const config = { schedule: "@hourly" };
