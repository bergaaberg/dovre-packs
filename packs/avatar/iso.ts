/**
 * Voxels as an isometric SVG, seen from the front left (the creature faces the viewer's left;
 * `facing: "right"` mirrors it). No library, no rotation.
 *
 * In this projection every cube face covers exactly two triangles of one triangular grid, with
 * lattice points at u = x − z, v = x + z − 2y (a vertical edge is 2 in v). So each layer keeps, per
 * grid triangle, only the nearest face (larger x + y + z is nearer), and what's left never overlaps:
 * all triangles of a part in one colour go into one path. Coordinates stay whole numbers, scaled to
 * the screen by the group around them (W = cos 30°, H = 1/2).
 *
 * Layers are drawn back → body → head, each over a complete layer under it, so the head can nod
 * and the tail sway without leaving holes. Parts are groups (`av-<part>`) for the animations in
 * src/ui/style.ts (AVATAR_CSS). Only numbers and the palettes' colours reach the markup.
 */
import { LAYERS, type Layer, layerOf, PARTS, type Part, type Voxel } from "./model.ts";

const W = 0.8660254;
const H = 0.5;
const HEX = /^#[0-9a-f]{6}$/i;

/** A colour a little lighter or darker (f > 1 lighter). */
export function shade(hex: string, f: number): string {
  if (!HEX.test(hex)) return "#808080";
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

const hash = (x: number, y: number, z: number) => {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

/** One grid triangle: its vertical edge from (u, v) to (u, v + 2), the third point left or right. */
type Tri = { u: number; v: number; side: "L" | "R" };
type Face = "top" | "front" | "side";
const FACE_SHADE: Record<Face, number> = { top: 1, front: 0.84, side: 0.68 };

/** The two triangles a face covers. */
function trianglesOf(x: number, y: number, z: number, face: Face): Tri[] {
  if (face === "top") {
    const u = x - z, v = x + z - 2 * y - 2;
    return [{ u, v, side: "L" }, { u, v, side: "R" }];
  }
  if (face === "front") {
    const u = x - z - 1, v = x + z + 1 - 2 * y;
    return [{ u, v: v - 2, side: "R" }, { u: u + 1, v: v - 1, side: "L" }];
  }
  const u = x - z + 1, v = x + 1 + z - 2 * y;
  return [{ u, v: v - 2, side: "L" }, { u: u - 1, v: v - 1, side: "R" }];
}

export type IsoOpts = {
  facing?: "left" | "right";
  /** Accessible name; drawn as <title>. Plain text, escaped. */
  label?: string;
  /** Classes on the root group (moods, src/ui/style.ts). Letters, digits and dashes only. */
  className?: string;
  /** A soft shadow under the feet (it squashes when the creature hops). */
  shadow?: boolean;
  /** Extra room above, in grid units, for hops. */
  headroom?: number;
  /** A <style> to put inside (an SVG used as an image can't see the page's stylesheet). */
  style?: string;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The SVG for a set of voxels. */
export function isoSvg(voxels: Voxel[], o: IsoOpts = {}): string {
  const mirror = o.facing === "right" ? -1 : 1;
  const byKey = new Map(voxels.map((v) => [`${v.x},${v.y},${v.z}`, v]));
  // Per layer, per triangle: the nearest face's part and colour.
  type Cell = { d: number; part: Part; c: string; glow: boolean };
  const layers = Object.fromEntries(LAYERS.map((l) => [l, new Map<string, Cell>()])) as Record<Layer, Map<string, Cell>>;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const vx of voxels) {
    if (!HEX.test(vx.c) || !(PARTS as readonly string[]).includes(vx.part)) continue;
    const { x, y, z } = vx;
    const layer = layers[layerOf(vx)];
    const jitter = [0.95, 1, 1.04][Math.floor(hash(x, y, z) * 3)]!;
    // A face hidden by a neighbour in the same layer isn't drawn; one next to another layer is (that layer may move).
    const same = (dx: number, dy: number, dz: number) => {
      const n = byKey.get(`${x + dx},${y + dy},${z + dz}`);
      return !!n && layerOf(n) === layerOf(vx);
    };
    const faces: Face[] = [];
    if (!same(0, 1, 0)) faces.push("top");
    if (!same(0, 0, 1)) faces.push("front");
    if (!same(1, 0, 0)) faces.push("side");
    for (const f of faces) {
      const c = vx.glow ? vx.c : shade(vx.c, FACE_SHADE[f] * jitter);
      for (const t of trianglesOf(x, y, z, f)) {
        const u = t.u * mirror, side = mirror < 0 ? (t.side === "L" ? "R" : "L") : t.side;
        const k = `${u},${t.v},${side}`;
        const d = x + y + z;
        const was = layer.get(k);
        if (!was || d >= was.d) layer.set(k, { d, part: vx.part, c, glow: !!vx.glow });
        minU = Math.min(minU, u - 1);
        maxU = Math.max(maxU, u + 1);
        minV = Math.min(minV, t.v);
        maxV = Math.max(maxV, t.v + 2);
      }
    }
  }
  if (!Number.isFinite(minU)) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>`;
  const pathsOf = (layer: Map<string, { part: Part; c: string; glow: boolean }>, part: Part) => {
    const byColour = new Map<string, string[]>();
    for (const [k, t] of layer) {
      if (t.part !== part) continue;
      const [u, v, side] = k.split(",");
      const list = byColour.get(t.c) ?? [];
      list.push(`M${u} ${v}v2l${side === "L" ? -1 : 1}-1z`);
      byColour.set(t.c, list);
    }
    return [...byColour].map(([c, d]) => `<path fill="${c}" stroke="${c}" d="${d.join("")}"/>`).join("");
  };
  const group = (name: Layer) => {
    const inner = PARTS.map((p) => {
      const paths = pathsOf(layers[name], p);
      return paths ? (p === name ? paths : `<g class="${"av-" + p}">${paths}</g>`) : "";
    }).join("");
    return inner ? `<g class="${"av-" + name}">${inner}</g>` : "";
  };
  const room = Math.max(0, o.headroom ?? 6);
  const pad = 1;
  const x0 = (minU - pad) * W, x1 = (maxU + pad) * W;
  const y0 = (minV - pad - room) * H, y1 = (maxV + pad) * H;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const cls = (o.className ?? "").replace(/[^\w -]/g, "").trim();
  // The floor under the feet: a circle on the ground is a circle on this grid (y = 0: u = x − z, v = x + z).
  const shadow = o.shadow ? `<ellipse class="av-shadow" cx="0" cy="0" rx="8" ry="8" fill="#000" opacity=".22"/>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r2(x0)} ${r2(y0)} ${r2(x1 - x0)} ${r2(y1 - y0)}" width="${r2((x1 - x0) * 8)}" height="${r2((y1 - y0) * 8)}" role="img">` +
    (o.label ? `<title>${esc(o.label)}</title>` : "") +
    (o.style ? `<style>${o.style.replace(/<\//g, "")}</style>` : "") +
    `<g class="av${cls ? ` ${cls}` : ""}"><g transform="scale(${W} ${H})" stroke-width=".08" stroke-linejoin="round">${group("under")}${shadow}<g class="av-all">${group("back")}${group("body")}${group("head")}</g>${group("over")}</g></g></svg>`
  );
}
