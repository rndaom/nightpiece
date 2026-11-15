"""Build the six chess pieces and bake their light.

    blender -b --factory-startup -P assets/src/pieces.py -- --out public/assets
        [--samples 64] [--only k] [--preview shot.png] [--sheet views.png]

Writes <out>/pieces.glb (six meshes, geometry only), <out>/tex/pieces_ao.jpg
(red: ambient occlusion; green: how open each part is to the light from
straight overhead, past the piece's own overhangs; blue: 0 in and beside that
shadow, 1 clear of it) and
<out>/tex/pieces_glow.jpg (the light each piece's own glowing parts cast on
and into its stone: red from the seams, green from the eye, blue from the
marks, each stored as a square root). Both maps are one atlas, three cells by
two, read through UV1.

`--only k` builds one piece and skips the baking and the export, for looking
at a shape quickly. `--preview` renders the set in both stones; `--sheet`
renders it in plain clay from the front, three-quarter, side, back and top,
which is the quickest way to judge a silhouette.

Design. A Staunton set: turned pieces, chunky, with
big heads, thick collars and a broad flared foot, cut in twelve flats to the
round with a narrow chamfer down every edge, so that they read as carved and
painted by hand. Bone for Ivory, ebony for Void. Each stands on the same foot,
and the light lives in the grooves the turner left between foot, stem and head.

    pawn    0.86   a faceted ball on a collar, with a small round eye
    rook    1.08   a flared drum, a collar, a turret of six merlons round a
                   sunken deck; an arrow slit under the front merlon
    knight  1.26   a horse's head in planes on a turned plinth: a leaning,
                   faceted neck with the mane standing off it as a comb, and
                   a head (deep cheek, narrower muzzle, one long face) on a
                   joint cut square to the neck
    bishop  1.39   a mitre with a ball finial, cut on the diagonal; the light
                   down in the cut is its eye
    queen   1.565  a coronet of twelve points round a ball, a jewel in front
    king    1.70   a crown flaring to a flat top, a lozenge jewel in front, and
                   a cross with flared arms, cut both ways

Each rigid block is a "module" so the engine can make a piece breathe, turn
its head or come apart; the glowing core between two modules is skinned to
both, so it stretches. The object's `meta` property lists the modules bottom
to top (`pivot`, and for a head that turns about a leaning neck, `axis`),
which module the head starts at (`head`), where the eye is, and how a hand
should hold the piece.

Shapes are authored in game space: x right, y up, -z the way the piece faces.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib  # noqa: E402
from lib import GLOW_EYE, GLOW_MARK, GLOW_SEAM, box, cylinder, finish_glow, gb  # noqa: E402

V = Vector

CH = 0.012          # the chamfer every piece shares
SHARP = 14.0        # faces meeting at more than this many degrees get a hard edge
UV_SCALE = 1.0      # tiles of stone texture per square of surface


# ---------------------------------------------------------------------------
# Solids
# ---------------------------------------------------------------------------

def _closed(bm: bmesh.types.BMesh, name: str) -> bpy.types.Mesh:
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def loft(*rings: list[Vector]) -> bpy.types.Mesh:
    """A solid through a stack of rings (each the same number of points), capped at both ends.
    Between two rings cut from parallel-sided outlines every face is flat, whatever the taper."""
    bm = bmesh.new()
    layers = [[bm.verts.new(gb(p.x, p.y, p.z)) for p in r] for r in rings]
    n = len(layers[0])
    bm.faces.new(layers[0])
    bm.faces.new(layers[-1][::-1])
    for a, b in zip(layers, layers[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([a[i], b[i], b[j], a[j]])
    return _closed(bm, "loft")


def hull(points: list[Vector]) -> bpy.types.Mesh:
    """The convex solid round a set of points."""
    bm = bmesh.new()
    for p in points:
        bm.verts.new(gb(p.x, p.y, p.z))
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    out = bmesh.ops.convex_hull(bm, input=bm.verts[:], use_existing_faces=False)
    stray = list(dict.fromkeys(g for g in out["geom_interior"] + out["geom_unused"] if isinstance(g, bmesh.types.BMVert)))
    if stray:
        bmesh.ops.delete(bm, geom=stray, context="VERTS")
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=bm.verts[:], edges=bm.edges[:])
    return _closed(bm, "hull")


def slab(profile: list[tuple[float, float]], half) -> bpy.types.Mesh:
    """A plate cut to a side-on outline. `profile` lists (forward, up) points round the outline, and the
    plate reaches `half` to each side of the centre plane. `half` may be a function of (forward, up); kept
    affine, it gives a plate that thins evenly and whose two faces stay flat."""
    width = half if callable(half) else (lambda f, y: half)
    bm = bmesh.new()
    left = [bm.verts.new(gb(-width(f, y), y, -f)) for f, y in profile]
    right = [bm.verts.new(gb(width(f, y), y, -f)) for f, y in profile]
    bm.faces.new(left)
    bm.faces.new(right[::-1])
    n = len(profile)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([left[i], right[i], right[j], left[j]])
    return _closed(bm, "slab")


def plate(outline: list[tuple[float, float]], z0: float, z1: float) -> bpy.types.Mesh:
    """A plate cut to an outline seen from the front: `outline` lists (x, y) points, pushed from z0 back to z1."""
    bm = bmesh.new()
    near = [bm.verts.new(gb(x, y, z0)) for x, y in outline]
    far = [bm.verts.new(gb(x, y, z1)) for x, y in outline]
    bm.faces.new(near)
    bm.faces.new(far[::-1])
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([near[i], far[i], far[j], near[j]])
    return _closed(bm, "plate")


def spin(mesh: bpy.types.Mesh, angle: float) -> bpy.types.Mesh:
    """Turn a mesh about the piece's vertical axis."""
    mesh.transform(Matrix.Rotation(angle, 4, "Z"))
    return mesh


def fuse(*meshes: bpy.types.Mesh) -> bpy.types.Mesh:
    return lib.union(list(meshes)) if len(meshes) > 1 else meshes[0]


def carve(mesh: bpy.types.Mesh, *cutters: bpy.types.Mesh | None) -> bpy.types.Mesh:
    used = [c for c in cutters if c is not None]
    return lib.subtract(mesh, used) if used else mesh


def facet(mesh: bpy.types.Mesh, pick, offset: float) -> bpy.types.Mesh:
    """Cut a wide flat along chosen edges, before the solid gets its fine chamfer. `pick` is given the two
    ends of an edge in game space and says whether to cut it."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    game = lambda v: V((v.co.x, v.co.z, -v.co.y))            # noqa: E731
    edges = [e for e in bm.edges if pick(game(e.verts[0]), game(e.verts[1]))]
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=offset, offset_type="OFFSET", segments=1, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


# ---------------------------------------------------------------------------
# Finishing
# ---------------------------------------------------------------------------

def finish(mesh: bpy.types.Mesh, module, bevel: float = CH, uv_offset=(0.0, 0.0), keep=None) -> bpy.types.Mesh:
    """Chamfer a stone solid's outward corners and write its vertex colours and tiling UVs.
    Inward corners are left sharp, so the shadow in a reveal stays hard; so are the edges it stands on,
    and any edge `keep` picks out (it is given the edge's two ends in game space).
    `module` is an index, or a function of a face's centre (in game space) returning one."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.0), verts=bm.verts[:], edges=bm.edges[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    col, uv0, _ = lib._layers(bm)

    chamfers: set = set()
    if bevel > 0:
        game = lambda v: V((v.co.x, v.co.z, -v.co.y))        # noqa: E731
        hard = [e for e in bm.edges
                if len(e.link_faces) == 2 and e.is_convex and e.calc_face_angle(0.0) > math.radians(SHARP)
                and not all(v.co.z < 1e-4 for v in e.verts)
                and not (keep and keep(game(e.verts[0]), game(e.verts[1])))]
        if hard:
            result = bmesh.ops.bevel(bm, geom=hard, offset=bevel, offset_type="OFFSET", segments=1, profile=0.5,
                                     affect="EDGES", clamp_overlap=True)
            chamfers = set(result["faces"])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    for f in bm.faces:
        c = f.calc_center_median()
        m = module(V((c.x, c.z, -c.y))) if callable(module) else module
        edge = 1.0 if f in chamfers else 0.0
        for loop in f.loops:
            loop[col] = (m / 8.0, 0.0, edge, 0.0)
    lib._box_project(bm, uv0, uv_offset, UV_SCALE)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def make_object(mesh: bpy.types.Mesh, name: str) -> bpy.types.Object:
    """Like lib.make_object, but with every plane kept flat: only the bored eyes are smooth."""
    mesh.name = name
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.set_sharp_from_angle(angle=math.radians(SHARP))
    mesh.color_attributes.active_color = mesh.color_attributes[lib.COLOR]
    mesh.color_attributes.render_color_index = mesh.color_attributes.find(lib.COLOR)
    return obj


class Piece:
    """Collects the parts of one piece."""

    def __init__(self, kind: str, height: float):
        self.kind = kind
        self.height = height
        self.meshes: list[bpy.types.Mesh] = []
        self.modules: list[dict] = []
        self.meta: dict = {}
        self._parts = 0

    def block(self, name: str, pivot: tuple[float, float, float], **extra) -> int:
        """Declare the next rigid mass, bottom to top. Returns its index."""
        self.modules.append({"name": name, "pivot": list(pivot), **extra})
        return len(self.modules) - 1

    def stone(self, module, mesh: bpy.types.Mesh, bevel: float = CH, keep=None) -> None:
        """Add a stone solid to a module (an index, or a function of a face centre returning one).
        `keep` picks edges to leave unchamfered (see `finish`)."""
        self._parts += 1
        offset = (0.37 * self._parts + 0.11 * ord(self.kind), 0.53 * self._parts)
        self.meshes.append(finish(mesh, module, bevel, offset, keep))

    def glow(self, *meshes: bpy.types.Mesh | None) -> None:
        self.meshes.extend(m for m in meshes if m is not None)

    def build(self) -> bpy.types.Object:
        obj = make_object(lib.join_raw(self.meshes, f"piece_{self.kind}"), f"piece_{self.kind}")
        meta = {"kind": self.kind, "height": self.height, "modules": self.modules, **self.meta}
        obj["meta"] = json.dumps(meta)
        return obj


# ---------------------------------------------------------------------------
# Light: seams, eyes and marks
# ---------------------------------------------------------------------------
#
# A glowing part never burns evenly: it is brightest at its heart and falls away to its rim, so it reads
# as light inside the stone and not as a bright plate stuck on it. The data channel's green carries that:
# EDGE at the rim, 1 at the heart.

EDGE = 0.6


def grade(mesh: bpy.types.Mesh, level) -> bpy.types.Mesh:
    """Set how brightly each corner of a glowing part burns. `level` is given the corner's position in
    game space and returns 0 (rim) to 1 (heart)."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    col, _, _ = lib._layers(bm)
    for f in bm.faces:
        for loop in f.loops:
            q = loop.vert.co
            r, _, b, a = loop[col]
            loop[col] = (r, EDGE + (1.0 - EDGE) * max(0.0, min(1.0, level(V((q.x, q.z, -q.y))))), b, a)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def split(mesh: bpy.types.Mesh, point: Vector, normal: Vector) -> bpy.types.Mesh:
    """Give a solid corners along a plane (a point and a normal, in game space), for `grade` to brighten."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=gb(*point), plane_no=gb(*normal))
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def soften(mesh: bpy.types.Mesh, facing, inset: float, peak: float = 1.0) -> bpy.types.Mesh:
    """Let a lamp fade toward its rim. The faces that look along `facing` (a direction in game space, or
    a list of them) are the ones seen through the aperture: each is inset, its new inner face burns at
    `peak` (full brightness unless a quieter lamp is wanted) and its rim drops to EDGE."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    col, _, _ = lib._layers(bm)
    ways = [gb(*d).normalized() for d in (facing if isinstance(facing, list) else [facing])]
    shown = [f for f in bm.faces if any(f.normal.dot(d) > 0.9 for d in ways)]
    bmesh.ops.inset_region(bm, faces=shown, thickness=inset, use_boundary=True, use_even_offset=True)
    # The faces that were inset are still the ones in `shown`, now smaller: they are the heart. Every
    # other corner of the lamp is rim, or out of sight behind the stone.
    heart = {v for f in shown for v in f.verts}
    for f in bm.faces:
        for loop in f.loops:
            r, _, b, a = loop[col]
            loop[col] = (r, peak if loop.vert in heart else EDGE, b, a)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def seam(low: list[Vector], high: list[Vector], lower: int, upper: int, kind: float = GLOW_SEAM) -> bpy.types.Mesh:
    """The glowing core in the reveal between two modules, brightest along its middle. Its lower half
    follows the lower module and its upper ring the upper one, so it stretches when they move apart."""
    y0, y1 = low[0].y, high[0].y
    mid = (y0 + y1) / 2
    lift = lambda ring_, y: [V((q.x, y, q.z)) for q in ring_]      # noqa: E731
    heart = [(a + b) / 2 for a, b in zip(low, high)]
    core = loft(lift(low, y0 - 0.008), low, heart, high, lift(high, y1 + 0.008))
    finish_glow(core, lambda q: lower if q.y < mid + 1e-6 else upper, kind)
    return grade(core, lambda q: 1.0 - abs(q.y - mid) / (mid - y0))


def slit(w: float, h: float, y: float, face: float, module: int, facing: float = 0.0, depth: float = 0.04,
         glow: bool = True, kind: float = GLOW_EYE, shift: float = 0.0):
    """A rectangular window recessed into a vertical face that sits `face` from the axis.
    `facing` is the direction the face looks, as an angle about y: 0 = front (-z), pi/2 = +x;
    `shift` moves the window along the face, to the viewer's left."""
    dx, dz = math.sin(facing), -math.cos(facing)
    sx, sz = math.cos(facing) * shift, math.sin(facing) * shift
    c_cut = face - depth / 2 + 0.04
    cutter = box(w, h, depth + 0.08, cy=y, x=dx * c_cut + sx, z=dz * c_cut + sz, rot_y=facing)
    if not glow:
        return cutter, None
    c_glow = face - depth
    lamp = box(w + 0.008, h + 0.008, 0.01, cy=y, x=dx * c_glow + sx, z=dz * c_glow + sz, rot_y=facing)
    return cutter, soften(finish_glow(lamp, module, kind), (dx, 0.0, dz), 0.004 + 0.36 * w)


def lozenge(half: tuple[float, float], y: float, face_z: float, module: int, depth: float = 0.04):
    """A tall lozenge let into a front face at z = face_z. Returns (cutter, glow)."""
    outline = lambda s: [(0, y - half[1] * s), (half[0] * s, y), (0, y + half[1] * s), (-half[0] * s, y)]  # noqa: E731
    cutter = plate(outline(1.0), face_z - 0.08, face_z + depth)
    lamp = finish_glow(plate(outline(1.1), face_z + depth - 0.004, face_z + depth + 0.006), module, GLOW_EYE)
    return cutter, soften(lamp, (0.0, 0.0, -1.0), 0.4 * half[0])


# ---------------------------------------------------------------------------
# The six pieces
# ---------------------------------------------------------------------------
#
# Every piece is turned, as a Staunton piece is, and then cut in flats: twelve to the round, with a narrow
# chamfer down each edge, so that it reads as carved and painted by hand and not as a smooth solid. The
# rings a turner leaves between foot, stem, collar and head are where one block ends and the next begins,
# and the light lives in those grooves.

SIDES = 12
TURN_CH = 0.006         # the chamfer down the edges of a turned piece's flats
SLOT = 0.016            # the groove between two turned blocks, which the light sits in


def poly(r: float, y: float, sides: int = SIDES) -> list[Vector]:
    """A ring of `sides` points at height y whose flats lie r from the axis, one flat looking straight
    forward (-z), where an eye can sit on it."""
    reach = r / math.cos(math.pi / sides)
    return [V((math.sin(a) * reach, y, math.cos(a) * reach))
            for a in (math.pi / sides + i * math.tau / sides for i in range(sides))]


def turned(profile: list[tuple[float, float]], sides: int = SIDES) -> bpy.types.Mesh:
    """A solid of revolution cut in flats: `profile` lists (radius to the flats, height) from the bottom
    up, and both ends are closed flat."""
    return loft(*[poly(r, y, sides) for r, y in profile])


# A ball is turned smooth, not cut in flats: finer than SHARP both round and up, so that it takes no
# chamfer and is shaded as one round surface, with one soft highlight.
ROUND = 32
ROUND_TOP = 84.0                # how far up a ball runs before its small flat top, in degrees
ROUND_BANDS = 12


def ball(cy: float, r: float, low: float, high: float, bands: int) -> list[tuple[float, float]]:
    """The profile of a faceted ball about height cy, from `low` degrees below its middle to `high` above,
    in `bands` courses of flats."""
    return [(r * math.cos(t), cy + r * math.sin(t))
            for t in (math.radians(low + (high - low) * i / bands) for i in range(bands + 1))]


def groove(y: float, r: float, lower: int, upper: int) -> bpy.types.Mesh:
    """The light in the groove between two turned blocks: the lower ends at y, the upper begins SLOT above."""
    return seam(poly(r, y), poly(r, y + SLOT), lower, upper)


def bore(r: float, y: float, face: float, module: int, depth: float = 0.016, kind: float = GLOW_EYE, peak: float = 1.0):
    """A small round lamp let into the front of a piece, whose surface there is `face` in front of the
    axis, burning at its heart at `peak`. Returns (cutter, glow)."""
    cutter = cylinder(r, V((0.0, y, -face - 0.1)), V((0.0, y, -face + depth)), SIDES)
    lamp = cylinder(r + 0.003, V((0.0, y, -face + depth - 0.005)), V((0.0, y, -face + depth + 0.003)), SIDES)
    return cutter, soften(finish_glow(lamp, module, kind), (0.0, 0.0, -1.0), 0.45 * r, peak)


def near(point: Vector, reach: float):
    """For `keep`: the edges round a small socket, too fine to chamfer."""
    return lambda a, b: (a - point).length < reach and (b - point).length < reach


class Turned(Piece):
    """A piece turned on the lathe. Each block is added bottom to top; the foot is the same on all of them."""

    def turn(self, module: int, profile: list[tuple[float, float]], *cutters, keep=None, sides: int = SIDES) -> None:
        self.stone(module, carve(turned(profile, sides), *cutters), bevel=TURN_CH, keep=keep)

    def base(self, r: float, h: float = 0.10) -> float:
        """The foot: a broad disc, a step and a bead, `r` out at the floor. Returns where it ends."""
        self.turn(0, [(r, 0.0), (r, 0.42 * h), (r - 0.026, 0.58 * h), (r - 0.026, 0.8 * h), (r - 0.05, h)])
        return h


def pawn() -> Piece:
    """A ball on a collar on a flared stem. Its eye is a small round light inlaid in the front of the ball,
    a little below its middle, and quieter than the others: there are eight of them in a row."""
    p = Turned("p", 0.86)
    foot = p.block("foot", (0, 0, 0))
    body = p.block("stem", (0, 0.10, 0))
    head = p.block("head", (0, 0.473, 0))

    h = p.base(0.28)
    y = h + SLOT
    p.turn(body, [(0.22, y), (0.215, y + 0.02), (0.18, y + 0.05), (0.15, y + 0.1), (0.13, y + 0.16), (0.122, 0.3), (0.118, 0.35),
                  (0.155, 0.37), (0.178, 0.385), (0.178, 0.418), (0.15, 0.44), (0.095, 0.455)])
    cy, r = 0.86 - 0.17 * math.sin(math.radians(ROUND_TOP)), 0.17
    eye_y = cy - 0.025
    face = r * math.cos(math.asin((eye_y - cy) / r)) - 0.001  # the ball's surface at the eye
    eye_cut, eye = bore(0.011, eye_y, face, head, depth=0.01, peak=0.8)
    p.turn(head, [(0.07, 0.473)] + ball(cy, r, -62, ROUND_TOP, ROUND_BANDS), eye_cut, keep=near(V((0, eye_y, -face)), 0.03),
           sides=ROUND)

    p.glow(groove(h, 0.2, foot, body), groove(0.455, 0.082, body, head), eye)
    p.meta = {"head": head, "eye": [0, round(eye_y, 4), round(-face, 4)],
              "grip": {"type": "pinch", "y": round(cy, 3), "half": r}}
    return p


def rook() -> Piece:
    """A flared drum, a collar, and a turret with six merlons round a sunken deck. An arrow slit under the
    front merlon is its eye, and the turret turns to look."""
    p = Turned("r", 1.08)
    foot = p.block("foot", (0, 0, 0))
    body = p.block("drum", (0, 0.10, 0))
    crown = p.block("turret", (0, 0.768, 0))

    h = p.base(0.32)
    y = h + SLOT
    p.turn(body, [(0.262, y), (0.256, y + 0.022), (0.226, y + 0.05), (0.208, y + 0.1), (0.198, y + 0.17), (0.19, 0.6), (0.19, 0.655),
                  (0.226, 0.675), (0.238, 0.692), (0.238, 0.728), (0.2, 0.75)])

    top, deck, wall = 1.08, 0.985, 0.262
    notches = []
    for k in range(6):
        a = math.pi / 6 + k * math.pi / 3                     # every other flat; the front one stands
        notches.append(box(0.092, 0.3, 0.2, y=deck + 0.012, x=math.sin(a) * wall, z=math.cos(a) * wall, rot_y=a))
    eye_cut, eye = slit(0.024, 0.1, 0.9, wall, crown)
    p.turn(crown, [(0.19, 0.768), (0.205, 0.785), (wall, 0.84), (wall, top)],
           turned([(0.19, deck), (0.19, top + 0.1)]), eye_cut, *notches)

    p.glow(groove(h, 0.24, foot, body), groove(0.75, 0.18, body, crown), eye)
    p.meta = {"head": crown, "eye": [0, 0.9, -wall], "grip": {"type": "wrap", "y": 0.6, "half": 0.19}}
    return p


def knight() -> Piece:
    """A horse carved in broad planes on a turned plinth. The neck arches forward off the plinth, full in
    the crest and hollow at the throat; the head is carried low on a joint cut square to the neck, so it
    turns about the neck and not about the plumb line. The jaw is the biggest shape on it, a deep rounded
    plate each side; the face runs long and straight to a short square muzzle, cut with a nostril and a
    mouth; a brow ridge shades each eye, and two short ears prick forward over a forelock. The mane is a
    ridge of big stepped locks down the back of the neck."""
    p = Turned("n", 1.26)
    lean = math.radians(42.0)
    cs, sn = math.cos(lean), math.sin(lean)
    joint = (-0.065, 0.695)                                  # (forward, up) of the middle of the joint
    lift = SLOT                                              # the groove between neck and head, along the axis

    def world(u: float, v: float) -> tuple[float, float]:
        """From the head's own frame (u along the joint toward the throat, v up the neck) to (forward, up)."""
        return (joint[0] + u * cs + v * sn, joint[1] - u * sn + v * cs)

    def local(f: float, y: float) -> tuple[float, float]:
        df, dy = f - joint[0], y - joint[1]
        return (df * cs - dy * sn, df * sn + dy * cs)

    def side(points: list[tuple[float, float, float]]) -> bpy.types.Mesh:
        """A convex block given by (forward, up, half width) points, each taken to both sides."""
        return hull([V((s * w, y, -f)) for f, y, w in points for s in (-1, 1)])

    def beyond(v: float, below: bool) -> bpy.types.Mesh:
        """Everything on one side of the plane square to the neck at height v in the head's frame."""
        far = -2.0 if below else 2.0
        return slab([world(-2.0, v), world(2.0, v), world(2.0, v + far), world(-2.0, v + far)], 1.0)

    foot = p.block("foot", (0, 0, 0))
    body = p.block("neck", (0, 0.10, 0))
    head = p.block("head", (0, joint[1], -joint[0]), axis=[0.0, round(cs, 5), round(-sn, 5)])

    h = p.base(0.32)
    y = h + SLOT
    sole = 0.2                                               # where the horse stands on its turned plinth
    p.turn(body, [(0.262, y), (0.256, y + 0.022), (0.236, y + 0.05), (0.236, y + 0.07), (0.205, y + 0.1), (0.19, sole + 0.045)])

    # The neck: the chest swells forward off the plinth and the throat falls back under the jaw, the crest
    # runs full and round up the back. Broad flats down its front and back corners make the chest a prow.
    neck_half = lambda f, y: 0.165 - 0.075 * (y - sole) - 0.05 * f       # noqa: E731  fuller in the crest
    neck = slab([(-0.215, sole), (0.2, sole), (0.262, 0.29), (0.258, 0.37), (0.22, 0.45), (0.16, 0.51),
                 (0.13, 0.6), (-0.2, 0.95), (-0.262, 0.84), (-0.29, 0.66), (-0.292, 0.5), (-0.27, 0.34)], neck_half)
    facet(neck, lambda a, b: a.x * b.x > 1e-6 and min(-a.z, -b.z) > 0.12, 0.06)
    facet(neck, lambda a, b: a.x * b.x > 1e-6 and max(-a.z, -b.z) < -0.2, 0.07)
    p.stone(body, carve(neck, beyond(0.0, False)))

    # The head, every mass of it kept above the joint so that it can turn right round. One long plane runs
    # from the poll to the nose, its sides dropping across a facet; the muzzle ends square and deep. Behind
    # and below, the jaw rounds the head off in a deep curve, its broad flat cheek falling away all round
    # across a ring of facets, so the head is widest across the jaws.
    jaw_c, jaw_r = (-0.03, 0.835), 0.155
    arc = lambda r, w, turns: [(jaw_c[0] + r * math.cos(math.radians(t)), jaw_c[1] + r * math.sin(math.radians(t)), w)   # noqa: E731
                               for t in turns]
    face = side([(-0.11, 1.135, 0.06), (0.315, 0.79, 0.045),
                 (-0.13, 1.09, 0.112), (0.295, 0.76, 0.08),
                 (0.352, 0.745, 0.062), (0.358, 0.66, 0.064), (0.33, 0.6, 0.06),
                 (0.25, 0.585, 0.08), (0.14, 0.56, 0.09), world(0.27, lift) + (0.085,)]
                + arc(jaw_r, 0.095, (110, 150, 190, 230, 270, 310))
                + arc(0.8 * jaw_r, 0.12, (130, 170, 210, 250, 290, 330, 10)))
    # The jaw itself stands a little proud of that: an oval plate lying along the face.
    tilt = math.radians(-50.0)
    oval = lambda k, w, turn: [(jaw_c[0] - 0.01 + k * (0.175 * math.cos(t) * math.cos(tilt) - 0.135 * math.sin(t) * math.sin(tilt)),   # noqa: E731
                                jaw_c[1] - 0.025 + k * (0.175 * math.cos(t) * math.sin(tilt) + 0.135 * math.sin(t) * math.cos(tilt)), w)
                               for t in (math.radians(turn + 45 * i) for i in range(8))]
    jaw = side(oval(1.0, 0.105, 0) + oval(0.66, 0.148, 22.5))
    # The poll and the top of the neck behind the jaw, down to the joint.
    crest = side([(-0.11, 1.135, 0.06), (-0.19, 1.06, 0.085), (-0.255, 0.93, 0.095), world(-0.215, lift) + (0.1,),
                  world(0.0, lift) + (0.11,), (-0.05, 0.75, 0.11)])
    # A ridge of brow over each eye, standing out from the side of the face along its top edge.
    eu, ey = 0.02, 0.968                                     # the eye: forward, up
    slope = (math.cos(math.radians(41.0)), -math.sin(math.radians(41.0)))    # down the face
    brows = []
    for s in (-1, 1):
        pts = []
        for t, d, w in ((-0.075, 0.0, 0.095), (0.075, 0.0, 0.095), (-0.07, 0.022, 0.142), (0.065, 0.022, 0.142),
                        (-0.06, 0.05, 0.118), (0.05, 0.05, 0.118)):
            f = eu + t * slope[0] - 0.012 + d * slope[1]
            yy = ey + t * slope[1] + 0.045 - d * slope[0]
            pts.append(V((s * w, yy, -f)))
        brows.append(hull(pts))

    # The eyes: a long lozenge let in under each brow, lying along the face.
    centres, sockets, lamps = [], [], []
    along = V((0.0, slope[1], -slope[0]))
    for s in (-1, 1):
        e = V((s * 0.118, ey, -eu))
        n = V((s * 1.0, 0.0, 0.0))

        def gem(grow: float, inner: float, outer: float) -> bpy.types.Mesh:
            up = V((0.0, slope[0], slope[1]))
            rim = [along * 0.05 * grow, up * 0.017 * grow, along * -0.05 * grow, up * -0.017 * grow]
            return hull([e + q + n * d for q in rim for d in (inner, outer)])

        centres.append(e)
        sockets.append(gem(1.0, -0.02, 0.1))
        lamps.append(soften(finish_glow(gem(1.12, -0.027, -0.017), head, GLOW_EYE), (s * 1.0, 0.0, 0.0), 0.007))

    # The nostrils, cut slanting into the corners of the muzzle, and the mouth, cut back from its end.
    nostrils = [box(0.05, 0.016, 0.07, cy=0.712, x=s * 0.066, z=-0.35, rot_y=s * 0.7, rot_z=s * 0.5) for s in (-1, 1)]
    mouth = box(0.4, 0.012, 0.16, cy=0.636, z=-0.42)
    p.stone(head, carve(fuse(face, jaw, crest, *brows), *sockets, *nostrils, mouth, beyond(lift, True)),
            keep=lambda a, b: any((a - e).length < 0.06 and (b - e).length < 0.06 for e in centres))

    # The ears: two short fins at the poll, pricked forward and leaning apart, cut level at the full height.
    root = (-0.085, 1.1)
    up = (math.sin(math.radians(14.0)), math.cos(math.radians(14.0)))    # (forward, up) along an ear
    reach = p.height + 0.03
    tip = root[0] + (reach - root[1]) / up[1] * up[0]
    ear = [(root[0] - 0.058 * up[1] - 0.03 * up[0], root[1] + 0.058 * up[0] - 0.03 * up[1]),
           (root[0] + 0.058 * up[1] - 0.03 * up[0], root[1] - 0.058 * up[0] - 0.03 * up[1]),
           (tip + 0.006, reach), (tip - 0.006, reach)]
    ear_half = lambda f, y: 0.03 - 0.1 * (y - root[1] + 0.03)        # noqa: E731
    hinge = gb(0.0, -sn, -cs)
    for s in (-1, 1):
        pivot = gb(s * 0.062, root[1], -root[0])
        mesh = slab(ear, ear_half)
        mesh.transform(Matrix.Translation(pivot) @ Matrix.Rotation(s * math.radians(12.0), 4, hinge)
                       @ Matrix.Translation((0, -pivot.y, -pivot.z)))
        p.stone(head, carve(mesh, box(1.0, 0.2, 1.0, y=p.height)), bevel=0.007)

    # The forelock, falling forward between the ears onto the brow.
    p.stone(head, side([(-0.085, 1.158, 0.02), (-0.06, 1.16, 0.028), (0.02, 1.066, 0.03), (0.055, 1.022, 0.012),
                        (-0.09, 1.11, 0.03), (0.0, 1.02, 0.03)]), bevel=0.006)

    # The mane: big locks stepped down the back of the neck, each standing out further at its lower end
    # than the next one begins, as a ridge and not a comb. The top lock rides on the head.
    back = [(-0.12, 1.12), (-0.215, 1.0), (-0.27, 0.86), (-0.296, 0.70), (-0.3, 0.55), (-0.284, 0.40)]

    def along_back(t: float) -> tuple[V, V]:
        """A point on the back line (t from 0 at the poll to 1), and the way out from it."""
        spans = list(zip(back, back[1:]))
        k = min(int(t * len(spans)), len(spans) - 1)
        a, b = V(spans[k][0]), V(spans[k][1])
        q = a + (b - a) * (t * len(spans) - k)
        d = (b - a).normalized()
        return q, V((d.y, -d.x)) if d.y < 0 else V((-d.y, d.x))

    def lock(t0: float, t1: float, rise: float) -> bpy.types.Mesh:
        a, na = along_back(t0)
        b, nb = along_back(t1)
        outline = [a - na * 0.05, a + na * 0.012, b + nb * rise, b - nb * 0.05]
        return slab([(q.x, q.y) for q in outline], lambda f, y: 0.05)

    locks = [(0.04, 0.3, 0.05), (0.3, 0.52, 0.055), (0.52, 0.76, 0.055), (0.76, 1.0, 0.045)]
    for i, (t0, t1, rise) in enumerate(locks):
        mane = lock(t0, t1, rise)
        if i == 0:
            p.stone(head, carve(mane, beyond(lift, True)), bevel=0.008)
        else:
            p.stone(body, carve(mane, beyond(0.0, False)), bevel=0.008)

    # Light in the joint: a groove like every other piece's, its core sunk well inside both blocks.
    mid = lift / 2
    rows = (-0.008, 0.0, mid, lift, lift + 0.008)            # across the joint: buried, lip, heart, lip, buried
    core = slab([world(u, v) for u, vs in ((-0.16, rows), (0.18, rows[::-1])) for v in vs], 0.055)
    finish_glow(core, lambda q: body if local(-q.z, q.y)[1] < mid else head, GLOW_SEAM)
    p.glow(groove(h, 0.24, foot, body), grade(core, lambda q: 1.0 - abs(local(-q.z, q.y)[1] - mid) / mid), *lamps)

    # A hand takes it across the jaws, low on them, where the head is widest and clear of the brows,
    # and far enough back that its fingers come away without touching the nose.
    hold = (-0.01, 0.79)
    p.meta = {"head": head, "eye": [0, round(ey, 4), round(-eu, 4)],
              "grip": {"type": "hook", "y": hold[1], "half": 0.145, "z": -hold[0]}}
    return p


def bishop() -> Piece:
    """A mitre on a collar on a tall stem, with a ball for a finial. The mitre's slit, cut on the diagonal
    into its front, is its eye: the light is down in the cut."""
    p = Turned("b", 1.39)
    foot = p.block("foot", (0, 0, 0))
    body = p.block("stem", (0, 0.10, 0))
    head = p.block("mitre", (0, 0.818, 0))

    h = p.base(0.30)
    y = h + SLOT
    p.turn(body, [(0.242, y), (0.236, y + 0.022), (0.2, y + 0.05), (0.168, y + 0.11), (0.148, y + 0.19), (0.128, 0.62), (0.122, 0.7),
                  (0.16, 0.72), (0.186, 0.735), (0.186, 0.768), (0.15, 0.788), (0.1, 0.8)])

    fy = 1.39 - 0.06 * math.sin(math.radians(ROUND_TOP))
    mitre = [(0.085, 0.818), (0.112, 0.84), (0.152, 0.885), (0.168, 0.955), (0.162, 1.035), (0.136, 1.115),
             (0.092, 1.19), (0.052, 1.24), (0.04, 1.258), (0.03, 1.272)]
    p.turn(head, [(0.026, 1.268)] + ball(fy, 0.06, -55, ROUND_TOP, ROUND_BANDS), sides=ROUND)
    tilt, cy = 0.62, 1.04
    cut = lambda thick, back: box(0.5, thick, 0.34, cy=cy, z=back - 0.17, rot_z=tilt)    # noqa: E731
    p.turn(head, mitre, cut(0.03, 0.02))
    # The light fills the cut a little way under the stone, brightest along its middle.
    inner = turned([(max(r - 0.026, 0.01), q) for r, q in mitre[1:8]])
    centre, normal = V((0.0, cy, 0.0)), V((-math.sin(tilt), math.cos(tilt), 0.0))
    blade = split(lib.intersect(cut(0.034, 0.03), inner), centre, normal)
    finish_glow(blade, head, GLOW_EYE)

    p.glow(groove(h, 0.22, foot, body), groove(0.8, 0.075, body, head),
           grade(blade, lambda q: 1.0 - abs((q - centre).dot(normal)) / 0.017))
    p.meta = {"head": head, "eye": [0, cy, -0.15], "grip": {"type": "tripod", "y": 0.752, "half": 0.186}}
    return p


def queen() -> Piece:
    """A tall stem, a collar, and a coronet flaring to twelve points round a ball. A round jewel in the
    coronet's front is her eye."""
    p = Turned("q", 1.565)
    foot = p.block("foot", (0, 0, 0))
    body = p.block("stem", (0, 0.10, 0))
    head = p.block("coronet", (0, 1.043, 0))

    h = p.base(0.32)
    y = h + SLOT
    p.turn(body, [(0.262, y), (0.256, y + 0.022), (0.216, y + 0.055), (0.182, y + 0.12), (0.16, y + 0.2), (0.138, 0.8), (0.13, 0.92),
                  (0.162, 0.94), (0.196, 0.958), (0.196, 0.99), (0.16, 1.01), (0.1, 1.025)])

    rim, wide = 1.43, 0.215
    points = []
    for k in range(SIDES):
        a = math.pi / SIDES + k * math.tau / SIDES           # a notch at every corner leaves a point on every flat
        notch = box(0.074, 0.074, 0.3, cy=rim, z=wide, rot_z=math.pi / 4)
        points.append(spin(notch, a))
    ey = 1.3
    eye_cut, eye = bore(0.016, ey, 0.187, head, peak=0.85)    # a jewel, kept below the coronet's light
    p.turn(head, [(0.09, 1.043), (0.1, 1.068), (0.145, 1.09), (0.145, 1.115), (0.11, 1.135), (0.118, 1.2),
                  (0.168, 1.3), (wide, 1.385), (wide, rim)],
           turned([(0.15, rim - 0.04), (0.185, rim + 0.05)]), eye_cut, *points, keep=near(V((0, ey, -0.187)), 0.05))
    by = 1.565 - 0.066 * math.sin(math.radians(ROUND_TOP))
    p.turn(head, [(0.04, rim - 0.05)] + ball(by, 0.066, -60, ROUND_TOP, ROUND_BANDS), sides=ROUND)

    p.glow(groove(h, 0.24, foot, body), groove(1.025, 0.082, body, head), eye)
    p.meta = {"head": head, "eye": [0, ey, -0.187], "grip": {"type": "pinch", "y": 1.2, "half": 0.12}}
    return p


def king() -> Piece:
    """The tallest: a stem, a double collar, a crown flaring out to a flat top, and on it a cross with
    flared arms, cut both ways so it reads as a cross from every side and from above. A lozenge jewel in
    the crown's front is his eye."""
    p = Turned("k", 1.70)
    foot = p.block("foot", (0, 0, 0))
    body = p.block("stem", (0, 0.11, 0))
    head = p.block("crown", (0, 1.118, 0))

    h = p.base(0.35, 0.11)
    y = h + SLOT
    p.turn(body, [(0.29, y), (0.284, y + 0.022), (0.24, y + 0.06), (0.205, y + 0.13), (0.18, y + 0.22), (0.152, 0.86), (0.144, 0.96),
                  (0.18, 0.978), (0.212, 0.994), (0.212, 1.026), (0.17, 1.042), (0.198, 1.056), (0.198, 1.08),
                  (0.12, 1.1)])

    ey = 1.29
    face = 0.125 + 0.09 * (ey - 1.14) / 0.26
    eye_cut, eye = lozenge((0.026, 0.044), ey, -face, head, depth=0.03)
    p.turn(head, [(0.11, 1.118), (0.126, 1.14), (0.215, 1.4), (0.226, 1.418), (0.2, 1.44), (0.12, 1.452)],
           eye_cut, keep=near(V((0, ey, -face)), 0.07))

    arms = [(-0.062, 1.43), (0.062, 1.43), (0.04, 1.562), (0.138, 1.542), (0.138, 1.658), (0.04, 1.638),
            (0.062, 1.70), (-0.062, 1.70), (-0.04, 1.638), (-0.138, 1.658), (-0.138, 1.542), (-0.04, 1.562)]
    t = 0.04
    p.stone(head, fuse(plate(arms, -t, t), spin(plate(arms, -t, t), math.pi / 2)), bevel=0.008)

    p.glow(groove(h, 0.27, foot, body), groove(1.1, 0.1, body, head), eye)
    p.meta = {"head": head, "eye": [0, ey, round(-face, 4)], "grip": {"type": "wrap", "y": 1.01, "half": 0.212}}
    return p


BUILDERS = [pawn, rook, knight, bishop, queen, king]
ATLAS = (3, 2)          # cells across and down
CELL = 512
SPILL_GAIN = 1.0        # what a stored 1.0 means, in units of the glowing part's own brightness
SPILL_DEPTH = 0.05      # how far light travels inside the stone, in squares
KEY_SPREAD = 14.0       # degrees across the patch of sky the overhead light is baked as coming from
KEY_WASH = 110.0        # and across the far wider patch that stands in for it on steep faces
KEY_STEEP = (0.12, 0.42)  # how far a face looks up (0 a wall, 1 a floor) where the wash gives way to the crisp shadow
KEY_MARGIN = 0.03       # how near its own shadow, in squares, a piece stops asking the engine about other shadows


# ---------------------------------------------------------------------------
# The light the pieces cast on themselves
# ---------------------------------------------------------------------------

def bake_cover(objects: list[bpy.types.Object], image: bpy.types.Image) -> np.ndarray:
    """Which texels of the atlas (UV1) lie on a piece: an array of booleans, rows bottom to top."""
    scene = bpy.context.scene
    mat = bpy.data.materials.new("cover")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    glow = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(glow.outputs[0], out.inputs["Surface"])
    target = nt.nodes.new("ShaderNodeTexImage")
    target.image = image
    nt.nodes.active = target
    before = scene.cycles.samples
    scene.cycles.samples = 1
    for i, obj in enumerate(objects):
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="EMIT", margin=0, use_clear=(i == 0), uv_layer=lib.UV_UNIQUE)
        obj.data.materials.clear()
    bpy.data.materials.remove(mat)
    scene.cycles.samples = before
    return lib.image_pixels(image)[..., 0] > 0.5


def settle(values: np.ndarray, cover: np.ndarray, sigma: float, margin: int = 8) -> np.ndarray:
    """Quiet a baked map. Inside each island it is blurred a little, which takes the grain of the path
    tracer out of it; the blur never reaches across the empty texels between islands. Then every island
    is grown `margin` texels into the empty space, so that filtering at its edge finds its own values.
    `values` is (rows, columns) or (rows, columns, channels)."""
    flat = values.reshape(values.shape[0], values.shape[1], -1).astype(np.float32)
    weight = cover.astype(np.float32)

    def blur(a: np.ndarray) -> np.ndarray:
        reach = max(1, int(math.ceil(2.5 * sigma)))
        taps = np.exp(-0.5 * (np.arange(-reach, reach + 1) / sigma) ** 2)
        taps /= taps.sum()
        for axis in (0, 1):
            padded = np.pad(a, [(reach, reach) if k == axis else (0, 0) for k in range(a.ndim)], mode="edge")
            a = sum(t * np.take(padded, np.arange(i, i + a.shape[axis]), axis=axis) for i, t in enumerate(taps))
        return a

    if sigma > 0:
        spread = blur(weight)
        flat = np.where(cover[..., None], blur(flat * weight[..., None]) / np.maximum(spread, 1e-6)[..., None], 0.0)
    filled = cover.copy()
    for _ in range(margin):
        total = np.zeros_like(flat)
        count = np.zeros(filled.shape, dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    total += np.roll(np.where(filled[..., None], flat, 0.0), (dy, dx), axis=(0, 1))
                    count += np.roll(filled.astype(np.float32), (dy, dx), axis=(0, 1))
        grow = ~filled & (count > 0)
        flat[grow] = total[grow] / count[grow][:, None]
        filled |= grow
    return flat.reshape(values.shape)


def bake_spill(objects: list[bpy.types.Object], image: bpy.types.Image, samples: int) -> np.ndarray:
    """Bake what each piece's own glowing parts do to its stone, into the atlas on UV1: red is the
    light of the seams, green of the eye, blue of the marks. The stone is given a little translucency
    for the bake, so the light also soaks a short way in from the reveals and comes out soft, as it
    does in alabaster. A value of 1 is a surface as bright as the glowing part itself.
    Returns the result as an array (rows bottom to top, three channels), without a margin."""
    scene = bpy.context.scene
    mat = bpy.data.materials.new("spill")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.82, 0.82, 0.82, 1)
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.subsurface_method = "RANDOM_WALK"
    bsdf.inputs["Subsurface Weight"].default_value = 1.0
    bsdf.inputs["Subsurface Radius"].default_value = (1.0, 1.0, 1.0)
    bsdf.inputs["Subsurface Scale"].default_value = SPILL_DEPTH
    # Emission from the data channel: green flags a glowing part, alpha says which kind it is.
    data = nt.nodes.new("ShaderNodeVertexColor")
    data.layer_name = lib.COLOR
    split = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(data.outputs["Color"], split.inputs["Color"])

    def math_node(operation: str, a, b) -> bpy.types.NodeSocket:
        node = nt.nodes.new("ShaderNodeMath")
        node.operation = operation
        for socket, value in zip(node.inputs, (a, b)):
            if isinstance(value, (int, float)):
                socket.default_value = value
            else:
                nt.links.new(value, socket)
        return node.outputs[0]

    kind = data.outputs["Alpha"]
    is_eye = math_node("GREATER_THAN", kind, 0.9)
    is_seam = math_node("LESS_THAN", kind, 0.4)
    is_mark = math_node("SUBTRACT", math_node("SUBTRACT", 1.0, is_eye), is_seam)
    colour = nt.nodes.new("ShaderNodeCombineColor")
    nt.links.new(is_seam, colour.inputs[0])
    nt.links.new(is_eye, colour.inputs[1])
    nt.links.new(is_mark, colour.inputs[2])
    nt.links.new(colour.outputs[0], bsdf.inputs["Emission Color"])
    nt.links.new(split.outputs["Green"], bsdf.inputs["Emission Strength"])
    target = nt.nodes.new("ShaderNodeTexImage")
    target.image = image
    nt.nodes.active = target

    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    before = scene.cycles.samples
    scene.cycles.samples = samples
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    for i, obj in enumerate(objects):
        for other in objects:
            other.hide_render = other is not obj
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=0, use_clear=(i == 0),
                            uv_layer=lib.UV_UNIQUE)
        print(f"baked spill: {obj.name}", flush=True)
    for obj in objects:
        obj.hide_render = False
        obj.data.materials.clear()
    bpy.data.materials.remove(mat)
    scene.cycles.samples = before
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0

    w, h = image.size
    pixels = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    light = np.clip(pixels.reshape(h, w, 4)[..., :3] / SPILL_GAIN, 0.0, 1.0)
    print("spill: mean %.4f, 99th percentile %.3f, clipped %.2f%%" % (
        float(light.mean()), float(np.percentile(light, 99)), 100.0 * float((light >= 1.0).mean())), flush=True)
    return light


def bake_key(objects: list[bpy.types.Object], image: bpy.types.Image, samples: int) -> np.ndarray:
    """Bake how much of the light from overhead reaches each part of a piece past its own overhangs.
    The oculus is so high that its light is never more than a few degrees off plumb anywhere on the
    board, so this can be worked out once, softly, instead of by the engine's shadow map, which has too
    few texels for the steep faces under a cantilever.

    A face that looks up gets the true, crisp shadow. A wall cannot: light that grazes it draws every
    chamfer above it down its whole height as a staircase, and the engine's key is a few degrees off
    plumb in a different direction on every square. So a wall is given a wash instead, the shadow of a
    far wider patch of sky, which is dark close under an overhang and opens out gently below it.

    Returns two arrays (rows bottom to top, without a margin). In the first, 1 is open to the light
    and 0 is in the piece's own shadow, or turned away from the light altogether. The second marks
    the texels on faces that look up which that crisp shadow touches at all, its soft edge included."""
    scene = bpy.context.scene
    mat = bpy.data.materials.new("key")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1)
    bsdf.inputs["Roughness"].default_value = 1.0
    target = nt.nodes.new("ShaderNodeTexImage")
    target.image = image
    nt.nodes.active = target
    sun = _light(scene, "SUN", 1.0, (0, 0, 10), (0, 0, 0), angle=math.radians(KEY_SPREAD))
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    before = scene.cycles.samples
    scene.cycles.samples = samples
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(mat)

    def light(shadows: bool, spread: float) -> np.ndarray:
        sun.data.angle = math.radians(spread)
        for i, obj in enumerate(objects):
            for other in objects:
                other.hide_render = other is not obj
            obj.visible_shadow = shadows
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT"}, margin=0, use_clear=(i == 0),
                                uv_layer=lib.UV_UNIQUE)
            obj.visible_shadow = True
        return lib.image_pixels(image)[..., 0].copy()

    shaded, free = light(True, KEY_SPREAD), light(False, KEY_SPREAD)
    washed, wash = light(True, KEY_WASH), light(False, KEY_WASH)
    for obj in objects:
        obj.hide_render = False
        obj.data.materials.clear()
    bpy.data.materials.remove(mat)
    data = sun.data
    bpy.data.objects.remove(sun)
    bpy.data.lights.remove(data)
    scene.cycles.samples = before
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0

    def share(part: np.ndarray, whole: np.ndarray) -> np.ndarray:
        return np.where(whole > 1e-4, np.clip(part / np.maximum(whole, 1e-4), 0.0, 1.0), 0.0)

    # Without shadows the narrow light reads a face's own tilt: the most it reads anywhere is a floor.
    lit = free > 1e-4
    floor = float(np.percentile(free[lit], 99.5)) if lit.any() else 1.0
    tilt = np.clip((free / floor - KEY_STEEP[0]) / (KEY_STEEP[1] - KEY_STEEP[0]), 0.0, 1.0)
    crisp = tilt * tilt * (3.0 - 2.0 * tilt)
    soft = share(washed, wash)
    sharp = share(shaded, free)
    opening = soft + (sharp - soft) * crisp
    faces = wash > 1e-4
    print("key: %.1f%% of the stone that faces the light is in its own shadow" % (
        100.0 * float((opening[faces] < 0.5).mean()) if faces.any() else 0.0), flush=True)
    return opening, lit & (crisp > 0.5) & (sharp < 0.97)


def spread(mask: np.ndarray, cover: np.ndarray, steps: int) -> np.ndarray:
    """Grow a set of texels `steps` texels outward over the stone, never across the empty texels
    between islands."""
    out = mask & cover
    for _ in range(steps):
        grown = out.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    grown |= np.roll(out, (dy, dx), axis=(0, 1))
        out = grown & cover
    return out


def texel_scale(obj: bpy.types.Object) -> float:
    """How many texels of the atlas lie along one square of a piece's stone."""
    mesh = obj.data
    uv = mesh.uv_layers[lib.UV_UNIQUE].data
    stone = texels = 0.0
    for poly in mesh.polygons:
        at = [uv[i].uv for i in poly.loop_indices]
        texels += abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(at, at[1:] + at[:1]))) / 2
        stone += poly.area
    return math.sqrt(texels * ATLAS[0] * ATLAS[1] * CELL * CELL / stone) if stone > 0 else 0.0


# ---------------------------------------------------------------------------
# Looking at them outside the engine
# ---------------------------------------------------------------------------

def _film(scene, width: int, height: int, samples: int) -> None:
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012, 0.012, 0.011, 1)
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.film_transparent = False
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.image_settings.file_format = "PNG"


def _light(scene, kind: str, energy: float, location, rotation, colour=(1, 1, 1), **settings) -> bpy.types.Object:
    data = bpy.data.lights.new(kind.lower(), kind)
    data.energy = energy
    data.color = colour
    for k, v in settings.items():
        setattr(data, k, v)
    obj = bpy.data.objects.new(data.name, data)
    obj.location = location
    obj.rotation_euler = [math.radians(a) for a in rotation]
    scene.collection.objects.link(obj)
    return obj


def _ground(scene, colour) -> None:
    mat = bpy.data.materials.new("ground")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*colour, 1)
    bsdf.inputs["Roughness"].default_value = 0.9
    ground = bpy.data.objects.new("ground", box(60, 0.2, 60, y=-0.2))
    ground.data.materials.append(mat)
    scene.collection.objects.link(ground)


def _stone_material(name: str, tex_dir: str, tex: str | None, emission, base=(0.6, 0.6, 0.58), roughness=0.8,
                    glow: float = 14.0) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*base, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    col = nt.nodes.new("ShaderNodeVertexColor")
    col.layer_name = lib.COLOR
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(col.outputs["Color"], sep.inputs["Color"])
    albedo = os.path.join(tex_dir, f"{tex}_albedo.jpg") if tex else ""
    if tex and os.path.exists(albedo):
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = lib.UV_TILE
        img = nt.nodes.new("ShaderNodeTexImage")
        img.image = bpy.data.images.load(albedo)
        nt.links.new(uv.outputs["UV"], img.inputs["Vector"])
        nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
        relief = os.path.join(tex_dir, f"{tex}_normal.jpg")
        if os.path.exists(relief):
            nimg = nt.nodes.new("ShaderNodeTexImage")
            nimg.image = bpy.data.images.load(relief)
            nimg.image.colorspace_settings.name = "Non-Color"
            nmap = nt.nodes.new("ShaderNodeNormalMap")
            nmap.uv_map = lib.UV_TILE
            nmap.inputs["Strength"].default_value = 0.5
            nt.links.new(uv.outputs["UV"], nimg.inputs["Vector"])
            nt.links.new(nimg.outputs["Color"], nmap.inputs["Color"])
            nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Emission Color"].default_value = emission
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = glow
    nt.links.new(sep.outputs["Green"], mul.inputs[0])
    nt.links.new(mul.outputs[0], bsdf.inputs["Emission Strength"])
    return mat


def _stand(scene, src: bpy.types.Object, mat: bpy.types.Material, location, turn: float) -> bpy.types.Object:
    dup = src.copy()
    dup.data = src.data.copy()
    dup.data.materials.clear()
    dup.data.materials.append(mat)
    dup.location = location
    dup.rotation_euler[2] = math.radians(turn)
    scene.collection.objects.link(dup)
    return dup


def _camera(scene, location, rotation, lens: float | None = None, ortho: float | None = None) -> None:
    data = bpy.data.cameras.new("cam")
    if ortho is not None:
        data.type = "ORTHO"
        data.ortho_scale = ortho
        data.sensor_fit = "HORIZONTAL"
    else:
        data.lens = lens or 50
    cam = bpy.data.objects.new("cam", data)
    cam.location = location
    cam.rotation_euler = [math.radians(a) for a in rotation]
    scene.collection.objects.link(cam)
    scene.camera = cam


def preview(objects: list[bpy.types.Object], path: str, tex_dir: str) -> None:
    """A lit render of the set in both stones, under a light like the chapel's: hard and cool from
    overhead, warm and low from the corners."""
    scene = bpy.context.scene
    ivory = _stone_material("ivory", tex_dir, "limestone", (1.0, 0.72, 0.34, 1), base=(0.75, 0.7, 0.6), roughness=0.75)
    void = _stone_material("void", tex_dir, "basalt", (0.1, 0.8, 0.62, 1), base=(0.03, 0.035, 0.033), roughness=0.4)
    for row, mat in enumerate((ivory, void)):
        for i, src in enumerate(objects):
            _stand(scene, src, mat, ((i - (len(objects) - 1) / 2) * 1.0, row * 1.6, 0), 180 - 28)
    for src in objects:
        src.hide_render = True
    _ground(scene, (0.085, 0.08, 0.07))
    _light(scene, "SPOT", 3400, (-0.8, -0.6, 9.0), (4, -5, 0), (0.86, 0.9, 0.89), spot_size=math.radians(55),
           spot_blend=0.5, shadow_soft_size=0.2)
    _light(scene, "POINT", 26, (-4.6, -3.2, 0.9), (0, 0, 0), (1.0, 0.72, 0.5), shadow_soft_size=0.12)
    _light(scene, "POINT", 26, (4.6, -3.2, 0.9), (0, 0, 0), (1.0, 0.72, 0.5), shadow_soft_size=0.12)
    _light(scene, "AREA", 30, (0, -7, 3.0), (66, 0, 0), (0.75, 0.85, 0.9), size=7)
    _camera(scene, (0.5, -8.9, 3.9), (71, 0, 3.0), lens=62)
    _film(scene, 1800, 760, 72)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f"preview written to {path}", flush=True)


def sheet(objects: list[bpy.types.Object], path: str) -> None:
    """The set in plain clay from five sides and from above, one strip per view: <path>_front.png and so on.
    A single piece is shown from eight sides, named by its turn."""
    scene = bpy.context.scene
    clay = _stone_material("clay", "", None, (1.0, 0.75, 0.4, 1), base=(0.62, 0.6, 0.56), roughness=0.85, glow=6.0)
    n = len(objects)
    pitch = 1.25
    shown = [_stand(scene, src, clay, ((i - (n - 1) / 2) * pitch, 0, 0), 180) for i, src in enumerate(objects)]
    for src in objects:
        src.hide_render = True
    _ground(scene, (0.2, 0.2, 0.2))
    _light(scene, "SUN", 4.2, (0, 0, 10), (8, -10, 0), (1, 1, 1), angle=math.radians(3))
    _light(scene, "AREA", 110, (-5, -9, 3.5), (68, 0, -28), (1.0, 0.92, 0.85), size=8)
    width = n * pitch + 0.2
    base, _ = os.path.splitext(path)
    scale = 300 if n > 3 else 480
    _film(scene, int(width * scale), int(1.93 * scale), 40)
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.03, 0.03, 1)
    _camera(scene, (0, -20, 0.88), (90, 0, 0), ortho=width)
    views = (("front", 180), ("quarter", 180 - 38), ("side", 90), ("back", 0 + 30), ("rear", 0))
    if n == 1:                                                # one piece is walked right round
        views = tuple((f"{turn:03d}", turn) for turn in range(180, 180 - 360, -45))
    for name, turn in views:
        for dup in shown:
            dup.rotation_euler[2] = math.radians(turn)
        scene.render.filepath = f"{base}_{name}.png"
        bpy.ops.render.render(write_still=True)
    for dup in shown:
        dup.rotation_euler[2] = math.radians(180)
    scene.render.resolution_y = int(1.2 * scale)
    _camera(scene, (0, 0, 20), (0, 0, 0), ortho=width)
    scene.render.filepath = f"{base}_top.png"
    bpy.ops.render.render(write_still=True)
    print(f"sheet written to {base}_*.png", flush=True)


# ---------------------------------------------------------------------------

def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--samples", type=int, default=64)
    ap.add_argument("--only", default=None, help="build a single piece by letter, without baking")
    ap.add_argument("--no-bake", action="store_true", help="build every piece but skip the baking and the export")
    ap.add_argument("--preview", default=None)
    ap.add_argument("--sheet", default=None)
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)

    lib.reset_scene()
    lib.setup_cycles(a.samples)

    objects = []
    for i, make in enumerate(BUILDERS):
        piece = make()
        if a.only and piece.kind not in a.only:
            for m in piece.meshes:
                bpy.data.meshes.remove(m)
            continue
        obj = piece.build()
        cx, cy = i % ATLAS[0], i // ATLAS[0]
        lib.unwrap_unique(obj, (cx / ATLAS[0], 1 - (cy + 1) / ATLAS[1], (cx + 1) / ATLAS[0], 1 - cy / ATLAS[1]))
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        xs = [v.co.x for v in obj.data.vertices]
        ys = [v.co.y for v in obj.data.vertices]
        zs = [v.co.z for v in obj.data.vertices]
        print(f"piece {piece.kind}: {tris} triangles, {len(piece.modules)} modules, "
              f"{max(xs) - min(xs):.3f} wide, {max(ys) - min(ys):.3f} deep, {max(zs):.3f} tall", flush=True)
        objects.append(obj)

    if not a.only and not a.no_bake:
        size = (ATLAS[0] * CELL, ATLAS[1] * CELL)
        atlas = bpy.data.images.new("pieces_bake", *size, alpha=False, float_buffer=True)
        atlas.colorspace_settings.name = "Non-Color"
        cover = bake_cover(objects, atlas)
        lib.bake_ao(objects, atlas, floor_y=0.0, margin=0)
        shade = np.ones((size[1], size[0], 3), dtype=np.float32)
        shade[..., 0] = settle(lib.image_pixels(atlas)[..., 0], cover, 1.0)
        opening, own = bake_key(objects, atlas, max(a.samples * 2, 96))
        shade[..., 1] = settle(opening, cover, 1.0)
        # Blue: clear of the piece's own shadow. The engine's shadow map draws that shadow again, a
        # texel or two out of place under a low overhang and farther under a high one (its light is a
        # few degrees off plumb), and the two together read as a smudge. So in its own shadow and
        # beside it a piece keeps to what is baked here, and asks the engine only farther out.
        near = np.zeros_like(cover)
        for i, obj in enumerate(objects):
            cx, cy = i % ATLAS[0], i // ATLAS[0]
            cell = (slice((ATLAS[1] - 1 - cy) * CELL, (ATLAS[1] - cy) * CELL), slice(cx * CELL, (cx + 1) * CELL))
            near[cell] = spread(own[cell], cover[cell], math.ceil(KEY_MARGIN * texel_scale(obj)))
        shade[..., 2] = settle(1.0 - near.astype(np.float32), cover, 1.0)
        lib.save_rgb_jpeg(shade, os.path.join(out, "tex", "pieces_ao.jpg"))
        spill = settle(bake_spill(objects, atlas, max(a.samples * 4, 128)), cover, 2.0)
        lib.save_rgb_jpeg(np.sqrt(spill), os.path.join(out, "tex", "pieces_glow.jpg"))
        lib.export_glb(objects, os.path.join(out, "pieces.glb"))

    if a.sheet:
        sheet(objects, os.path.abspath(a.sheet))
    elif a.preview:
        preview(objects, os.path.abspath(a.preview), os.path.join(out, "tex"))


if __name__ == "__main__":
    main()
