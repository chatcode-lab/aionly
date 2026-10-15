/**
 * How wide text set in a TrueType font is, read from the font file itself:
 * its character map and horizontal metrics. Covers wrap titles with it, so
 * the font that draws the text is the one that measured it. Kerning is left
 * out, which makes a line measure a little wider than it draws: safe for
 * wrapping.
 */
export interface FontMetrics {
  /** The advance of a character in ems, or null when the font lacks it. */
  advance(codePoint: number): number | null;
}

export function readFontMetrics(buffer: ArrayBuffer): FontMetrics {
  const view = new DataView(buffer);
  const tables = new Map<string, number>();
  const count = view.getUint16(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(tag, view.getUint32(record + 8));
  }
  const table = (tag: string) => {
    const offset = tables.get(tag);
    if (offset === undefined) throw new Error(`font has no ${tag} table`);
    return offset;
  };

  const unitsPerEm = view.getUint16(table("head") + 18);
  const longMetrics = view.getUint16(table("hhea") + 34);
  const hmtx = table("hmtx");
  const advanceOf = (glyph: number) => view.getUint16(hmtx + Math.min(glyph, longMetrics - 1) * 4);
  const glyphOf = characterMap(view, table("cmap"));
  const cache = new Map<number, number | null>();

  return {
    advance(codePoint) {
      let width = cache.get(codePoint);
      if (width === undefined) {
        const glyph = glyphOf(codePoint);
        width = glyph === 0 ? null : advanceOf(glyph) / unitsPerEm;
        cache.set(codePoint, width);
      }
      return width;
    },
  };
}

/** The glyph for a character, from the best Unicode subtable: format 12, else 4. */
function characterMap(view: DataView, cmap: number): (codePoint: number) => number {
  const subtables = view.getUint16(cmap + 2);
  let format4: number | null = null;
  for (let index = 0; index < subtables; index += 1) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const offset = cmap + view.getUint32(record + 4);
    const format = view.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) return format12(view, offset);
    if (format === 4) format4 ??= offset;
  }
  if (format4 === null) throw new Error("font has no Unicode character map");
  return format4Lookup(view, format4);
}

function format12(view: DataView, offset: number) {
  const groups = view.getUint32(offset + 12);
  return (codePoint: number) => {
    let low = 0;
    let high = groups - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const group = offset + 16 + middle * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      if (codePoint < start) high = middle - 1;
      else if (codePoint > end) low = middle + 1;
      else return view.getUint32(group + 8) + codePoint - start;
    }
    return 0;
  };
}

function format4Lookup(view: DataView, offset: number) {
  const segments = view.getUint16(offset + 6) / 2;
  const ends = offset + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (codePoint: number) => {
    if (codePoint > 0xffff) return 0;
    for (let index = 0; index < segments; index += 1) {
      if (view.getUint16(ends + index * 2) < codePoint) continue;
      const start = view.getUint16(starts + index * 2);
      if (start > codePoint) return 0;
      const delta = view.getInt16(deltas + index * 2);
      const rangeOffset = view.getUint16(rangeOffsets + index * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyph = view.getUint16(rangeOffsets + index * 2 + rangeOffset + (codePoint - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}
