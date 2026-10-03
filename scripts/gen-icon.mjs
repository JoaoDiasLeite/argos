// Generates build/icon.png (512×512) with no external deps: the dog mark from
// src/renderer/src/brand/argos-mark.json (the same path the title bar and the rail
// draw) in the accent on a dark rounded square, rasterised here with an even-odd
// scanline fill and 4×4 supersampling, then encoded as a PNG via zlib.
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mark = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/src/brand/argos-mark.json'), 'utf8'))

const S = 512
const SS = 4 // supersampling per axis
const BG = [0x1c, 0x1b, 0x19] // --bg-1
const ACCENT = [0xdf, 0x7a, 0x52] // --accent (Warm Rust)

// ── Path → polygons (flatten cubics) ──
const [vx, vy, vw] = mark.viewBox.split(/\s+/).map(Number)
const inset = 0.12 // the mark occupies 76 % of the tile
const scale = (S * (1 - 2 * inset)) / vw
const tx = (x) => (x - vx) * scale + S * inset
const ty = (y) => (y - vy) * scale + S * inset

const tokens = mark.d.match(/[MLCZ]|-?\d*\.?\d+/g)
const polys = []
let poly = null
let cur = [0, 0]
let i = 0
let last = 'M'
const num = () => Number(tokens[i++])
while (i < tokens.length) {
  // potrace repeats a command implicitly: a number where a command is expected means "same again".
  let t = tokens[i++]
  if (/^[MLCZ]$/.test(t)) last = t
  else {
    i--
    t = last === 'M' ? 'L' : last
  }
  if (t === 'M') {
    cur = [num(), num()]
    poly = [[tx(cur[0]), ty(cur[1])]]
    polys.push(poly)
  } else if (t === 'L') {
    cur = [num(), num()]
    poly.push([tx(cur[0]), ty(cur[1])])
  } else if (t === 'C') {
    const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()]
    const [x0, y0] = cur
    const n = 24
    for (let k = 1; k <= n; k++) {
      const u = k / n
      const a = (1 - u) ** 3
      const b = 3 * (1 - u) ** 2 * u
      const c = 3 * (1 - u) * u * u
      const d = u ** 3
      poly.push([tx(a * x0 + b * x1 + c * x2 + d * x3), ty(a * y0 + b * y1 + c * y2 + d * y3)])
    }
    cur = [x3, y3]
  } else if (t === 'Z') {
    // closed implicitly by the fill
  } else {
    throw new Error(`unexpected token ${t}`)
  }
}

// Even-odd point test against every polygon (holes are their own subpaths).
const inside = (x, y) => {
  let c = false
  for (const p of polys) {
    for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
      const [xa, ya] = p[a]
      const [xb, yb] = p[b]
      if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) c = !c
    }
  }
  return c
}

// ── Rounded-square background ──
const margin = 20
const rad = 104
const lo = margin
const hi = S - 1 - margin
const inRounded = (x, y) => {
  if (x < lo || x > hi || y < lo || y > hi) return false
  const nx = Math.min(Math.max(x, lo + rad), hi - rad)
  const ny = Math.min(Math.max(y, lo + rad), hi - rad)
  return (x - nx) ** 2 + (y - ny) ** 2 <= rad * rad
}

// ── Raster ──
// `withBg` false is the dev variant: just the mark, on a transparent background.
const rasterise = (withBg) => {
  const px = Buffer.alloc(S * S * 4)
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bgHits = 0
      let markHits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS
          const fy = y + (sy + 0.5) / SS
          if (withBg && !inRounded(fx, fy)) continue
          bgHits++
          if (inside(fx, fy)) markHits++
        }
      }
      if (!bgHits) continue
      const o = (y * S + x) * 4
      if (withBg) {
        const cover = bgHits / (SS * SS)
        const m = markHits / bgHits
        for (let c = 0; c < 3; c++) px[o + c] = Math.round(BG[c] * (1 - m) + ACCENT[c] * m)
        px[o + 3] = Math.round(255 * cover)
      } else if (markHits) {
        for (let c = 0; c < 3; c++) px[o + c] = ACCENT[c]
        px[o + 3] = Math.round((255 * markHits) / bgHits)
      }
    }
  }
  return px
}

// ── PNG encode ──
const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (let k = 0; k < buf.length; k++) c = crcTable[(c ^ buf[k]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6
const encode = (px) => {
  const raw = Buffer.alloc(S * (S * 4 + 1))
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
for (const [file, withBg] of [['icon.png', true], ['icon-dev.png', false]]) {
  const png = encode(rasterise(withBg))
  fs.writeFileSync(path.join(ROOT, 'build', file), png)
  console.log('wrote build/' + file, png.length, 'bytes')
}
