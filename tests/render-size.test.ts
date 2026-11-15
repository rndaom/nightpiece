import { describe, expect, it } from 'vitest';
import { STEPS } from '../src/scene/pace';
import { drawingRatio, governedRatio, governorSteps, qualityFor, type Quality } from '../src/scene/post';

/** The drawing buffer three.js makes for a canvas this size at this ratio. */
const buffer = (quality: Quality, width: number, height: number, dpr: number) => {
  const ratio = drawingRatio(quality, width, height, dpr);
  return `${Math.floor(width * ratio)}x${Math.floor(height * ratio)}`;
};

describe('the size the picture is drawn at', () => {
  // Screen (CSS pixels and device pixels to each), then low, medium and high. Before the budget,
  // low was four fifths of a CSS pixel everywhere: 288x512 on the smallest phone here.
  const TABLE: [number, number, number, string, string, string][] = [
    [360, 640, 3, '711x1264', '540x960', '720x1280'],
    [390, 844, 3, '644x1395', '585x1266', '780x1688'],
    [844, 390, 3, '1395x644', '1266x585', '1688x780'],
    [768, 1024, 2, '821x1095', '1095x1460', '1536x2048'],
    [1366, 768, 1, '1092x614', '1366x768', '1366x768'],
    [1920, 1080, 1, '1536x864', '1920x1080', '1920x1080'],
    [2560, 1440, 1, '2048x1152', '2560x1440', '2560x1440'],
    [3840, 2160, 1, '3072x1728', '3840x2160', '3840x2160'],
  ];
  for (const [w, h, dpr, low, medium, high] of TABLE) {
    it(`${w}x${h} at ${dpr}x`, () => {
      expect(buffer('low', w, h, dpr)).toBe(low);
      expect(buffer('medium', w, h, dpr)).toBe(medium);
      expect(buffer('high', w, h, dpr)).toBe(high);
    });
  }

  it('draws a phone at low at least as finely as its own CSS size', () => {
    for (const [w, h] of [[360, 640], [375, 667], [390, 844], [430, 932], [844, 390], [932, 430]]) {
      expect(drawingRatio('low', w!, h!, 3)).toBeGreaterThanOrEqual(1);
      expect(drawingRatio('low', w!, h!, 3) * drawingRatio('low', w!, h!, 3) * w! * h!).toBeLessThanOrEqual(0.9e6 + 1);
    }
  });

  it('never draws a desktop finer, nor coarser, than it was drawn before the budget', () => {
    const before: Record<Quality, number> = { low: 0.8, medium: 1.5, high: 2 };
    for (const [w, h] of [[1280, 720], [1366, 768], [1440, 900], [1920, 1080], [1920, 1200], [2560, 1440], [3840, 2160]]) {
      for (const dpr of [1, 1.25, 1.5, 2]) {
        for (const q of ['low', 'medium', 'high'] as Quality[]) {
          if (w! * h! < 0.9e6 && q === 'low') continue;
          if (w! * h! < 1.6e6 && q === 'medium') continue;
          expect(drawingRatio(q, w!, h!, dpr), `${q} ${w}x${h}@${dpr}`).toBe(Math.min(dpr, before[q]));
        }
      }
    }
  });

  it('lets the governor take a phone no lower than three quarters of its budget, and a desktop to half a pixel as before', () => {
    const phone = drawingRatio('low', 390, 844, 3);
    expect(governedRatio(phone, 0.5, 390, 844)).toBeCloseTo(phone * 0.75, 9);
    expect(governedRatio(phone, 0.85, 390, 844)).toBeCloseTo(phone * 0.85, 9);
    expect(governedRatio(phone, 0.6, 844, 390)).toBeCloseTo(phone * 0.75, 9);
    expect(governedRatio(1, 0.5, 1920, 1080)).toBe(0.5);
    expect(governedRatio(0.8, 0.5, 1920, 1080)).toBe(0.5);
    expect(governedRatio(1, 1, 1920, 1080)).toBe(1);
  });
});

describe("the governor's steps", () => {
  /** The steps as indices into STEPS, for reading. */
  const steps = (quality: Quality, w: number, h: number, dpr: number) => governorSteps(quality, w, h, dpr).map((s) => STEPS.indexOf(s));

  it('leaves out, on Low, the step that gives up smoothing it never had, and the sizes below its least', () => {
    // A desktop at Low is drawn at 0.8 of a pixel: 0.6 of that is already under the least of half a pixel, and 0.5 is the same picture again.
    expect(steps('low', 1920, 1080, 1)).toEqual([0, 1, 2, 4]);
    expect(steps('low', 1366, 768, 1)).toEqual([0, 1, 2, 4]);
    expect(steps('low', 1280, 720, 1)).toEqual([0, 1, 2, 4]);
  });

  it('keeps every step at Medium and High on a desktop', () => {
    for (const quality of ['medium', 'high'] as Quality[]) {
      for (const [w, h, dpr] of [[1366, 768, 1], [1920, 1080, 1], [2560, 1440, 1], [1440, 900, 2]]) {
        expect(steps(quality, w!, h!, dpr!), `${quality} ${w}x${h}@${dpr}`).toEqual([0, 1, 2, 3, 4, 5]);
      }
    }
  });

  it('stops a phone at three quarters of its budget, keeping the step that gives up smoothing where there is some', () => {
    expect(steps('low', 390, 844, 3)).toEqual([0, 1, 2]);
    expect(steps('medium', 390, 844, 3)).toEqual([0, 1, 2, 3]);
    expect(steps('high', 844, 390, 3)).toEqual([0, 1, 2, 3]);
  });

  it('gives each step a picture that is smaller, or no longer smoothed, or with its reflection eased', () => {
    for (const quality of ['low', 'medium', 'high'] as Quality[]) {
      for (const [w, h, dpr] of [[390, 844, 3], [768, 1024, 2], [1366, 768, 1], [1920, 1080, 1.25], [3840, 2160, 1]]) {
        const list = governorSteps(quality, w!, h!, dpr!);
        expect(list[0]).toBe(STEPS[0]);
        const full = drawingRatio(quality, w!, h!, dpr!);
        for (let i = 1; i < list.length; i++) {
          const [a, b] = [list[i - 1]!, list[i]!];
          const smaller = governedRatio(full, b.scale, w!, h!) < governedRatio(full, a.scale, w!, h!);
          expect(smaller || a.smooth !== b.smooth || a.scale === 1, `${quality} ${w}x${h}@${dpr} step ${i}`).toBe(true);
        }
      }
    }
  });
});

describe('the starting quality', () => {
  it('is low on phone graphics, an iPhone among them, and medium on a tablet or a desktop', () => {
    expect(qualityFor('Mali-G78', true, 412)).toBe('low');
    expect(qualityFor('Adreno (TM) 650', true, 393)).toBe('low');
    expect(qualityFor('PowerVR Rogue GE8320', true, 360)).toBe('low');
    expect(qualityFor('Apple GPU', true, 390)).toBe('low');
    expect(qualityFor('Apple GPU', true, 820)).toBe('medium');
    expect(qualityFor('Apple GPU', false, 900)).toBe('medium');
    expect(qualityFor('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', false, 982)).toBe('medium');
    expect(qualityFor('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', false, 1080)).toBe('low');
    expect(qualityFor('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics)', false, 1440)).toBe('medium');
    expect(qualityFor('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070)', false, 1440)).toBe('medium');
  });
});
