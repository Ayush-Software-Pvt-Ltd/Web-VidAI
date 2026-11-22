/** What the player part of the screen needs from the browser; tests provide a fake one. */
import { createContext, useContext } from "react";
import { createPlayerBridge, type CreatePlayerBridge } from "./playerBridge";
import { loadPlayerScript } from "./playerScript";

export interface PlayerEnv {
  loadScript: () => Promise<void>;
  createBridge: CreatePlayerBridge;
  /** How long the player may take to report ready before the preview address is renewed. */
  readyTimeoutMs: number;
}

export const DEFAULT_PLAYER_ENV: PlayerEnv = {
  loadScript: loadPlayerScript,
  createBridge: createPlayerBridge,
  readyTimeoutMs: 15_000,
};

export const PlayerEnvContext = createContext<PlayerEnv>(DEFAULT_PLAYER_ENV);

export function usePlayerEnv(): PlayerEnv {
  return useContext(PlayerEnvContext);
}
