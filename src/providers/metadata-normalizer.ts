// Shared query normalization — strips YouTube metadata noise before API queries
// Used by AppleSearchProvider and song-resolution query cleanup (DRY)

/** Strip YouTube-specific noise: "(Official Audio)", "[HD]", "- Topic", "VEVO", etc. */
export function normalizeForQuery(text: string): string {
  return text
    .replace(/\s*\(official\s*(audio|video|music\s*video|lyric\s*video|visualizer)\)/gi, '')
    .replace(/\s*\[official\s*(audio|video|music\s*video|lyric\s*video|visualizer)\]/gi, '')
    .replace(/\s*\((lyrics?|hd|hq|4k|live)\)/gi, '')
    .replace(/\s*\[(lyrics?|hd|hq|4k|live)\]/gi, '')
    .replace(/\s*\(feat\.?\s*[^)]+\)/gi, '')
    .replace(/\s*\(ft\.?\s*[^)]+\)/gi, '')
    .replace(/\s*\[feat\.?\s*[^\]]+\]/gi, '')
    .replace(/\s*\[ft\.?\s*[^\]]+\]/gi, '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/\s*VEVO$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
