import { api } from "encore.dev/api";
import { buildArena } from "./arena-repository";
import { ensureWeeklyCompetition } from "./live-engine";
import type { ArenaResponse } from "./types";

export const getArena = api(
  { expose: true, method: "GET", path: "/arena" },
  async (): Promise<ArenaResponse> => {
    await ensureWeeklyCompetition();
    return buildArena();
  },
);
