/** Loads the HyperFrames player element's script once, on demand (served by the server, SPEC section 11). */
import { PLAYER_TAG } from "./playerBridge";

export const PLAYER_SCRIPT_URL = "/assets/hyperframes-player.js";

let pending: Promise<void> | null = null;

export function loadPlayerScript(): Promise<void> {
  if (customElements.get(PLAYER_TAG)) return Promise.resolve();
  if (pending) return pending;
  const attempt = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAYER_SCRIPT_URL;
    script.async = true;
    const fail = () => {
      script.remove();
      pending = null;
      reject(new Error("The player script could not be loaded."));
    };
    script.onload = () => {
      if (customElements.get(PLAYER_TAG)) resolve();
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  pending = attempt;
  return attempt;
}
