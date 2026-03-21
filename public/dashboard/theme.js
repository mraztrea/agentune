import { appendDashboardTokenToPath } from './auth.js';
import { DEFAULT_THEME, PLACEHOLDER_ARTWORK } from './constants.js';

const themeCache = new Map();

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgba(color, alpha) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function mix(a, b, ratio) {
  return {
    r: clampChannel(a.r + (b.r - a.r) * ratio),
    g: clampChannel(a.g + (b.g - a.g) * ratio),
    b: clampChannel(a.b + (b.b - a.b) * ratio),
  };
}

function getSaturation({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function getLuminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function buildThemeFromSamples({ average, deepest, highlight, accent }) {
  const baseShadow = mix(deepest, average, 0.18);
  const shellFill = mix(deepest, highlight, 0.16);
  const shellSoft = mix(average, highlight, 0.1);
  const accentLine = mix(accent, highlight, 0.36);

  return {
    'ambient-start': rgba(mix(deepest, accent, 0.24), 0.97),
    'ambient-mid': rgba(mix(average, accent, 0.3), 0.7),
    'ambient-end': rgba(mix(deepest, { r: 4, g: 7, b: 13 }, 0.55), 0.99),
    surface: rgba(shellFill, 0.78),
    'surface-strong': rgba(mix(deepest, average, 0.2), 0.92),
    'surface-soft': rgba(shellSoft, 0.22),
    accent: rgba(accentLine, 1),
    'accent-soft': rgba(accent, 0.22),
    'shadow-tint': rgba(baseShadow, 0.52),
    'success-pill-bg': rgba(mix(accent, highlight, 0.3), 0.18),
    'success-pill-ink': 'rgba(244, 247, 255, 0.96)',
  };
}

function sampleArtworkPalette(imageData) {
  const fallback = {
    average: { r: 18, g: 28, b: 44 },
    deepest: { r: 10, g: 14, b: 22 },
    highlight: { r: 212, g: 228, b: 255 },
    accent: { r: 128, g: 168, b: 240 },
  };

  const { data } = imageData;
  let weightSum = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let deepest = fallback.deepest;
  let highlight = fallback.highlight;
  let accent = fallback.accent;
  let bestAccentScore = -1;
  let darkestScore = Infinity;
  let brightestScore = -1;

  for (let index = 0; index < data.length; index += 16) {
    const alpha = data[index + 3];
    if (alpha < 120) {
      continue;
    }

    const color = { r: data[index], g: data[index + 1], b: data[index + 2] };
    const luminance = getLuminance(color);
    const saturation = getSaturation(color);
    const weight = 0.35 + saturation;

    weightSum += weight;
    sumR += color.r * weight;
    sumG += color.g * weight;
    sumB += color.b * weight;

    if (luminance < darkestScore) {
      darkestScore = luminance;
      deepest = color;
    }

    if (luminance > brightestScore) {
      brightestScore = luminance;
      highlight = color;
    }

    const accentScore = saturation * 0.7 + Math.max(0, 1 - Math.abs(luminance - 150) / 150) * 0.3;
    if (accentScore > bestAccentScore) {
      bestAccentScore = accentScore;
      accent = color;
    }
  }

  if (weightSum === 0) {
    return fallback;
  }

  return {
    average: {
      r: clampChannel(sumR / weightSum),
      g: clampChannel(sumG / weightSum),
      b: clampChannel(sumB / weightSum),
    },
    deepest,
    highlight,
    accent,
  };
}

async function loadArtwork(url) {
  const image = new Image();
  // Required for canvas pixel reads when we fall back to a remote thumbnail URL.
  image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';

  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('Artwork load failed.'));
    image.src = url;
  });

  return image;
}

async function extractTheme(url) {
  const image = await loadArtwork(url);
  const canvas = document.createElement('canvas');
  canvas.width = 36;
  canvas.height = 36;
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (!context) {
    throw new Error('Canvas unavailable.');
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  return buildThemeFromSamples(sampleArtworkPalette(imageData));
}

async function extractThemeWithFallback(source) {
  const candidates = [buildArtworkUrl(source), source];
  let lastError = new Error('Artwork load failed.');

  for (const candidate of candidates) {
    try {
      const theme = await extractTheme(candidate);
      themeCache.set(candidate, theme);
      return theme;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Artwork load failed.');
    }
  }

  throw lastError;
}

export function buildArtworkUrl(source) {
  return source
    ? appendDashboardTokenToPath(`/api/artwork?src=${encodeURIComponent(source)}`)
    : PLACEHOLDER_ARTWORK;
}

export function createAmbientThemeManager(root = document.documentElement) {
  let activeArtwork = '';
  let requestToken = 0;

  function applyTheme(theme) {
    Object.entries(theme).forEach(([key, value]) => {
      root.style.setProperty(`--${key}`, value);
    });
  }

  async function sync(source) {
    if (!source) {
      activeArtwork = '';
      requestToken += 1;
      applyTheme(DEFAULT_THEME);
      return;
    }

    if (source === activeArtwork) {
      return;
    }

    activeArtwork = source;
    const token = ++requestToken;
    const proxied = buildArtworkUrl(source);
    const cached = themeCache.get(proxied) ?? themeCache.get(source);

    if (cached) {
      applyTheme(cached);
      return;
    }

    try {
      const theme = await extractThemeWithFallback(source);
      themeCache.set(proxied, theme);
      themeCache.set(source, theme);
      if (token === requestToken) {
        applyTheme(theme);
      }
    } catch {
      if (token === requestToken) {
        applyTheme(DEFAULT_THEME);
      }
    }
  }

  applyTheme(DEFAULT_THEME);
  return { sync };
}
