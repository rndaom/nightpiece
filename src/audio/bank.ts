/**
 * The game's sounds as they come off the disk: recordings, cut and laid end to end in a few
 * files by assets/src/sound/build.py, with a list of where each one is.
 *
 * Fetching and decoding are separate, because they happen at different times. The files are
 * fetched behind the loading screen. They can only be decoded once there is an audio output,
 * and a browser gives one only after the player has done something.
 */

/** sounds.json, as build.py writes it. */
export interface Manifest {
  rate: number;
  /** A short name for each file, and the file. */
  files: Record<string, string>;
  /** Each sound: the file it is in, and every take of it as [start, length] in seconds. */
  clips: Record<string, { file: string; takes: [number, number][] }>;
  /** Each loop: the file it is in and the stretch of it that repeats. */
  beds: Record<string, { file: string; start: number; length: number }>;
}

/** The files as fetched, not yet decoded. */
export interface RawBank {
  manifest: Manifest;
  data: Record<string, ArrayBuffer>;
}

/** One recording of a sound: a stretch of a longer buffer. */
export interface Take {
  buffer: AudioBuffer;
  start: number;
  length: number;
}

/** Everything, ready to play. */
export interface Bank {
  clips: Record<string, Take[]>;
  beds: Record<string, Take>;
  /** The chapel's echo. */
  hall: AudioBuffer | null;
}

/** Fetch the list and every file it names. Rejects if the list cannot be had; a missing file is only left out. */
export async function fetchBank(base = `${import.meta.env.BASE_URL}assets/sound/`): Promise<RawBank> {
  const response = await fetch(`${base}sounds.json`);
  if (!response.ok) throw new Error(`sounds.json: ${response.status}`);
  const manifest = (await response.json()) as Manifest;
  const data: Record<string, ArrayBuffer> = {};
  await Promise.all(
    Object.entries(manifest.files).map(async ([name, file]) => {
      try {
        const r = await fetch(`${base}${file}`);
        if (r.ok) data[name] = await r.arrayBuffer();
        else console.warn(`A sound file could not be fetched: ${file} (${r.status}).`);
      } catch (error) {
        console.warn(`A sound file could not be fetched: ${file}.`, error);
      }
    }),
  );
  return { manifest, data };
}

/** Decode the fetched files for one audio output. The fetched bytes are left as they were. */
export async function decodeBank(ctx: BaseAudioContext, raw: RawBank): Promise<Bank> {
  const buffers: Record<string, AudioBuffer> = {};
  await Promise.all(
    Object.entries(raw.data).map(async ([name, bytes]) => {
      try {
        // Decoding empties the buffer it is given, so it is given a copy.
        buffers[name] = await ctx.decodeAudioData(bytes.slice(0));
      } catch (error) {
        console.warn(`A sound file could not be decoded: ${name}.`, error);
      }
    }),
  );
  const clips: Record<string, Take[]> = {};
  for (const [name, clip] of Object.entries(raw.manifest.clips)) {
    const buffer = buffers[clip.file];
    if (buffer) clips[name] = clip.takes.map(([start, length]) => ({ buffer, start, length }));
  }
  const beds: Record<string, Take> = {};
  for (const [name, bed] of Object.entries(raw.manifest.beds)) {
    const buffer = buffers[bed.file];
    if (buffer) beds[name] = { buffer, start: bed.start, length: bed.length };
  }
  return { clips, beds, hall: buffers.hall ?? null };
}
