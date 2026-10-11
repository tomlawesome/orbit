/*
 * THE SHARED DOOR'S TYPES, FOR ORBIT'S TYPE CHECK (#1371 spec item 20).
 *
 * web/src/lib/door/ is orbit-site's folder, copied in unchanged (never edited
 * here) and written as plain JavaScript that does not pass Orbit's strict type
 * check. The check cannot be told to skip it: a file Orbit's code imports is
 * checked whatever `exclude` says. So web/tsconfig.json maps `$lib/door/*` to
 * this folder, and Orbit's code sees the folder's interface (the README's, and
 * what index.js exports) through these declarations instead of its source. The
 * bundler and the browser still get the real files: only the type check is
 * redirected.
 *
 * Written by hand from the folder's README.md, as the host's side of the
 * interface. Every name index.js exports is declared here, which
 * tests/unit/door-types-stub.test.mjs holds, so an import that adds an export
 * fails Orbit's unit suite until it is declared. Declared as constants of
 * function type rather than `function` declarations, so no source scan for the
 * host's own functions mistakes this file for Orbit's code.
 */

/** one household, as the flight passes it: `[x, y, colour, r]` bodies */
export interface HomeInput {
  name: string;
  bodies: Array<[number, number, string, number]>;
}

/** a prop of a flight profile (the folder's engine draws it) */
export interface Prop {
  kind: string;
  t0?: number;
  dur?: number;
  spin?: number;
  [key: string]: unknown;
}

/** a flight profile: `UP`, `DOWN`, or one made from them */
export interface Profile {
  dur?: number;
  rate?: number;
  skip?: number;
  props: Prop[];
  [key: string]: unknown;
}

export interface DoorSettings {
  /** where a picture is: `"dawn/dawn.webp"` becomes a URL the page can load */
  image?: (path: string) => string;
  /** the debug switches, read by the host */
  flags?: Record<string, string | boolean>;
  storagePrefix?: string;
  settle?: number;
  typingWait?: number;
}

export interface GpuGate {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  parallel: boolean;
  renderer: string;
}

export interface LightOptions {
  firstVisit?: boolean;
  wait?: boolean;
  after?: () => Promise<unknown> | null;
  onLit?: () => void;
  onOpen?: () => void;
  aside?: boolean;
}

export interface Dawn {
  start: () => void;
  light: (options?: LightOptions) => void;
  live: unknown;
  destroy: () => void;
  /** a getter in the folder: the pictures decoded ahead, now */
  readonly held: unknown;
  world: HTMLElement;
  host: HTMLElement;
}

export interface Dusk {
  start: () => void;
  destroy: () => void;
  held: unknown;
  world: HTMLElement;
  host: HTMLElement;
}

export interface JourneyHooks {
  release?: () => void;
  land?: () => void;
  settled?: () => void;
  released?: () => void;
  dusk?: () => void;
  surface?: () => void;
  farewell?: () => void;
}

export interface FlyOptions {
  title?: string;
  subtitle?: string;
  /** a promise the clock holds for just before the canvas comes up, at most eight seconds */
  ready?: Promise<unknown> | null;
  on?: JourneyHooks;
  /** pin the journey at this moment (ms into it as it plays) */
  at?: number;
}

export interface DescendOptions {
  title?: string;
  subtitle?: string;
  onto?: "dusk" | "dawn";
  from?: Profile | null;
  /** the other households met again on the way down */
  homes?: HomeInput[];
  on?: JourneyHooks;
  at?: number;
}

export interface JourneyOptions {
  canvas: HTMLCanvasElement;
  name: HTMLElement;
  dawnGlyph: () => Element | null;
  duskGlyph: () => Element | null;
  on?: JourneyHooks;
}

export interface Journey {
  fly: (profile: Profile, options?: FlyOptions) => void;
  ascend: (...args: unknown[]) => void;
  descend: (options?: DescendOptions) => void;
  reset: () => void;
  destroy: () => void;
  later: (fn: () => void, how?: { after?: number }) => () => void;
  /** a value, read once when the journey is made (not a function) */
  reduced: boolean;
  warm: (how?: { prove?: boolean }) => Promise<unknown>;
  warmDocs: (how?: { prove?: boolean }) => Promise<unknown>;
  compiled: () => Promise<unknown>;
}

export interface Door {
  settings: Required<DoorSettings>;
  dawn: (host: HTMLElement) => Dawn;
  dusk: (host: HTMLElement) => Dusk;
  journey: (options: JourneyOptions) => Journey;
}

export interface MarkupOptions {
  image?: (path: string) => string;
  gate?: string;
  foot?: string;
  indent?: string;
}

export interface DawnMarkupOptions extends MarkupOptions {
  lockup?: string;
}

export interface DuskMarkupOptions extends MarkupOptions {
  /** text, escaped by the folder */
  farewell?: { said: string; sub: string };
  asDawn?: boolean;
}

export const settings: Required<DoorSettings>;
export const createDoor: (given?: DoorSettings) => Door;
export const dawnMarkup: (options?: DawnMarkupOptions) => string;
export const duskMarkup: (options?: DuskMarkupOptions) => string;

export const gpu: () => GpuGate | null;
export const isSoftware: (renderer: string) => boolean;
export const FIT_MS: number;

export const UP: Profile;
export const DOWN: Profile;
export const DOWN_DAWN: Profile;
export const PROPS_UP: Prop[];
export const UPDUR: number;
export const DOWNDUR: number;
export const homeProps: (homes: HomeInput[]) => Prop[];
export const mirrored: (props: Prop[]) => Prop[];
export const descentProfile: (how?: { onto?: "dusk" | "dawn"; from?: Profile | null; homes?: HomeInput[] }) => Profile;
export const createFlight: (...args: unknown[]) => unknown;
export const createJourney: (options: JourneyOptions) => Journey;
export const mountDawn: (host: HTMLElement) => Dawn;
export const mountDusk: (host: HTMLElement) => Dusk;
export const decodeAhead: (...args: unknown[]) => unknown;

/** the background work: a host's own worlds queue their GPU work here too */
export const chore: (fn: () => unknown, rest?: number, tag?: string | string[], how?: { soft?: boolean }) => Promise<unknown>;
export const fetchOnce: (url: string) => Promise<unknown>;
export const linked: (label: string) => void;
export const counted: (label: string) => string;
export const note: (what: string, since?: number) => unknown;
export const noteChores: (when: string) => unknown;
export const quiet: () => Promise<() => boolean>;
export const openChores: () => void;
export const openCompiles: () => void;
export const openSoft: () => void;
export const softRan: () => { n: number; ms: number };
export const hurryChores: (tags?: string | string[], opening?: number) => void;
export const programs: () => { n: number; by: string };
export const compilesAside: () => boolean;
export const holdReveal: () => boolean;
export const uploadBanded: (...args: unknown[]) => unknown;

export const probe: (...args: unknown[]) => Promise<{ ok: boolean }>;
export const level: () => number;
export const liveDoor: (...args: unknown[]) => unknown;
export const lateDoor: (...args: unknown[]) => unknown;

export const seededRng: (seed: number) => () => number;
export const el: (...args: unknown[]) => Element;
export const measureTile: (...args: unknown[]) => unknown;
export const DAWN: unknown;
export const DUSK: unknown;
