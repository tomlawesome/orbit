import { notes as v0_3_7 } from "./v0.3.7";
import { notes as v0_3_8 } from "./v0.3.8";

/** One bold lead and one sentence (#1618). Plain text: no HTML. */
export interface Bullet {
  lead: string;
  text: string;
}

/** What one release tells people, in two parts; an empty part shows nothing. */
export interface ReleaseNotes {
  version: string;
  forEveryone: Bullet[];
  forAdministrators: Bullet[];
}

/** Every release's notes. Each `vX.Y.Z.ts` file is listed here is part of the release step. */
export const releaseNotes: ReleaseNotes[] = [v0_3_7, v0_3_8];
