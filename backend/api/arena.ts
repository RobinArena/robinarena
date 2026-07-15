import { api } from "encore.dev/api";
import { buildArena } from "./arena-repository";
import type { ArenaResponse } from "./types";

export const getArena = api(
  { expose: true, method: "GET", path: "/arena" },
  async (): Promise<ArenaResponse> => buildArena(),
);
