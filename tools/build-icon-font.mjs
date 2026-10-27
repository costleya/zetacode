// Rebuild with `node tools/build-icon-font.mjs`. Uses only Node built-ins.
// Sources are monochrome, round-capped/round-joined linear SVG strokes.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const join = (...parts) => Buffer.concat(parts.flat());
const pad = (b) => join(b, Buffer.alloc((4 - (b.length % 4)) % 4));
const checksum = (b) => {
  const p = pad(b);
  let n = 0;
  for (let i = 0; i < p.length; i += 4) n = (n + p.readUInt32BE(i)) >>> 0;
  return n;
};
function capsule(a, b, radius, scale) {
  const theta = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const points = [];
  // Same winding for every contour: overlaps use nonzero fill, including joins.
  for (const [center, start] of [
    [b, theta - Math.PI / 2],
    [a, theta + Math.PI / 2],
  ]) {
    for (let i = 0; i <= 16; i++) {
      const angle = start + (Math.PI * i) / 16;
      points.push([
        Math.round((center[0] + Math.cos(angle) * radius) * scale),
        Math.round(1024 - (center[1] + Math.sin(angle) * radius) * scale),
      ]);
    }
  }
  return points;
}

function outlines(file) {
  const svg = readFileSync(resolve(root, "assets", file), "utf8");
  const scale = Number(svg.match(/transform="scale\(([\d.]+)\)"/)?.[1]);
  if (
    !scale ||
    !svg.includes('stroke-linecap="round"') ||
    !svg.includes('stroke-linejoin="round"')
  ) {
    throw new Error(`Unsupported SVG stroke style: ${file}`);
  }
  const contours = [];
  for (const match of svg.matchAll(/<path d="([^"]+)" stroke-width="([\d.]+)"\s*\/>/g)) {
    const tokens = match[1].match(/[MLHV]|-?\d+(?:\.\d+)?/g);
    if (tokens.join("").replaceAll(" ", "") !== match[1].replaceAll(" ", ""))
      throw new Error(`Unsupported path: ${file}`);
    let point;
    for (let i = 0; i < tokens.length;) {
      const command = tokens[i++];
      const next =
        command === "H"
          ? [Number(tokens[i++]), point[1]]
          : command === "V"
            ? [point[0], Number(tokens[i++])]
            : [Number(tokens[i++]), Number(tokens[i++])];
      if (command !== "M") contours.push(capsule(point, next, Number(match[2]) / 2, scale));
      point = next;
    }
  }
  if (!contours.length) throw new Error(`No supported paths in ${file}`);
  return contours;
}

function glyph(contours) {
  if (!contours.length) return Buffer.alloc(0);
  const points = contours.flat(),
    xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  let end = -1,
    x = 0,
    y = 0;
  const ends = contours.map((c) => u16((end += c.length)));
  const dx = [],
    dy = [];
  for (const point of points) {
    dx.push(u16(point[0] - x));
    dy.push(u16(point[1] - y));
    [x, y] = point;
  }
  // OVERLAP_SIMPLE on the first point explicitly declares overlapping contours.
  const flags = Buffer.alloc(points.length, 1);
  flags[0] |= 0x40;
  return pad(join(u16(contours.length), bounds.map(u16), ends, u16(0), flags, dx, dy));
}

const sources = ["nesweep-glyph.svg", ...[1, 2, 3, 4].map((n) => `nesweep-load-${n}.svg`)];
const shapes = [[], ...sources.map(outlines)];
const glyphs = shapes.map(glyph);
const bounds = shapes.flat(2);
const xs = bounds.map((p) => p[0]),
  ys = bounds.map((p) => p[1]);
const fontBounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
const tables = new Map();
let offset = 0;
tables.set(
  "loca",
  join(
    glyphs.map((g) => {
      const b = u32(offset);
      offset += g.length;
      return b;
    }),
    u32(offset),
  ),
);
tables.set("glyf", join(glyphs));
tables.set(
  "head",
  join(
    u32(0x10000),
    u32(0x10000),
    u32(0),
    u32(0x5f0f3cf5),
    u16(3),
    u16(1024),
    Buffer.alloc(16),
    fontBounds.map(u16),
    u16(0),
    u16(8),
    u16(2),
    u16(1),
    u16(0),
  ),
);
tables.set(
  "hhea",
  join(
    u32(0x10000),
    u16(1024),
    u16(0),
    u16(0),
    u16(1024),
    u16(0),
    u16(1024 - fontBounds[2]),
    u16(fontBounds[2]),
    u16(1),
    Buffer.alloc(14),
    u16(shapes.length),
  ),
);
tables.set(
  "hmtx",
  join(
    shapes.map((contours) =>
      join(u16(1024), u16(contours.length ? Math.min(...contours.flat().map((p) => p[0])) : 0)),
    ),
  ),
);
tables.set(
  "maxp",
  join(
    u32(0x10000),
    u16(shapes.length),
    u16(Math.max(...shapes.map((s) => s.flat().length))),
    u16(Math.max(...shapes.map((s) => s.length))),
    u16(0),
    u16(0),
    u16(2),
    Buffer.alloc(16),
  ),
);
// Windows Unicode BMP format 4, one contiguous range EA01–EA05.
const cmap4 = join(
  u16(4),
  u16(32),
  u16(0),
  u16(4),
  u16(4),
  u16(1),
  u16(0),
  u16(0xea05),
  u16(0xffff),
  u16(0),
  u16(0xea01),
  u16(0xffff),
  u16(1 - 0xea01),
  u16(1),
  u16(0),
  u16(0),
);
tables.set("cmap", join(u16(0), u16(1), u16(3), u16(1), u32(12), cmap4));
const names = [
  [1, "NESweep Icons"],
  [2, "Regular"],
  [3, "NESweep Icons 1.0"],
  [4, "NESweep Icons"],
  [5, "Version 1.0"],
  [6, "NESweepIcons"],
];
let nameOffset = 0;
const strings = names.map(([, text]) =>
  Buffer.from(text.split("").flatMap((c) => [0, c.charCodeAt(0)])),
);
const records = names.map(([id], i) => {
  const record = join(u16(3), u16(1), u16(0x409), u16(id), u16(strings[i].length), u16(nameOffset));
  nameOffset += strings[i].length;
  return record;
});
tables.set("name", join(u16(0), u16(names.length), u16(6 + 12 * names.length), records, strings));
tables.set("post", join(u32(0x30000), Buffer.alloc(28)));
const os2 = Buffer.alloc(96);
os2.writeUInt16BE(4, 0);
os2.writeInt16BE(1024, 2);
os2.writeUInt16BE(400, 4);
os2.writeUInt16BE(5, 6);
os2.writeUInt32BE(0x10000000, 46);
os2.write("NESW", 58);
os2.writeUInt16BE(0x40, 62);
os2.writeUInt16BE(0xea01, 64);
os2.writeUInt16BE(0xea05, 66);
os2.writeInt16BE(1024, 68);
os2.writeUInt16BE(1024, 74);
os2.writeInt16BE(512, 86);
os2.writeInt16BE(768, 88);
os2.writeUInt16BE(32, 92);
os2.writeUInt16BE(1, 94);
tables.set("OS/2", os2);

// Build a standard TrueType SFNT font; VS Code accepts TTF icon fonts directly.
const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const n = entries.length,
  power = 2 ** Math.floor(Math.log2(n));
const sfntHeader = join(
  u32(0x10000),
  u16(n),
  u16(power * 16),
  u16(Math.log2(power)),
  u16((n - power) * 16),
);
let tableOffset = 12 + 16 * n;
const directory = entries.map(([tag, data]) => {
  const record = join(Buffer.from(tag), u32(checksum(data)), u32(tableOffset), u32(data.length));
  tableOffset += pad(data).length;
  return record;
});
const buildSfnt = () =>
  join(
    sfntHeader,
    directory,
    entries.map(([, data]) => pad(data)),
  );
const sfnt = buildSfnt();
tables.get("head").writeUInt32BE((0xb1b0afba - checksum(sfnt)) >>> 0, 8);
const font = buildSfnt();
if (checksum(font) !== 0xb1b0afba) throw new Error("Invalid TrueType font checksum");
writeFileSync(resolve(root, "assets/nesweep-icons.ttf"), font);
console.log(
  `Built ${n} tables; EA01–EA05; bounds ${fontBounds.join(", ")}; ${shapes
    .slice(1)
    .map((s) => s.flat().length)
    .join("/")} points.`,
);
