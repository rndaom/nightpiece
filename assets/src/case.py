"""Build the case: the board as a folding walnut box with brass at its corners, its
marble squares, and the four drawers the stones are kept in.

    blender -b --factory-startup -P assets/src/case.py -- --out public/assets
        [--samples 96] [--no-bake] [--preview shots] [--clay]

Writes <out>/board.glb and <out>/tex/case_ao.jpg (ambient occlusion, read through UV1, in all
three channels). `--no-bake` builds everything and skips the bake and the export; `--preview`
renders the case lit (or in plain clay, with `--clay`) from three-quarter, from the side and
shut from above, as <shots>_quarter.png, <shots>_side.png and <shots>_shut.png.

The case is two halves joined by a hinge along the middle of the board. Void's half (z < 0)
stays on the altar; Ivory's half (z > 0) is the lid: shut, it lies upside down on Void's half,
and it opens through half a turn about the hinge line (the x axis at z = 0, at the height of
the rim). Each half has a drawer under each of its two side rails, sliding out along x.

board.glb, every mesh in world space with the case open and its drawers shut:
    void_frame, lid_frame           the walnut of each half with its brass: corner caps on the
                                    rim, a kite shield down each outer corner, the hinge
                                    knuckles, the lozenges and their bosses; under the lid two
                                    framed panels and a piano hinge. Red is what a part is made
                                    of: 0 walnut, 0.5 brass, 1 baize. Blue = 1 on a chamfer.
                                    void_frame carries the case's measurements as `meta`.
    void_tiles_light, void_tiles_dark, lid_tiles_light, lid_tiles_dark
                                    the squares, a loose slab each, top at y = 0. Red = square
                                    index / 63 (a1 = 0, b1 = 1 ... h8 = 63); blue = 1 on a chamfer.
    void_inlay, lid_inlay           the coordinates set into the rim (red 0 brass, 1 the dark
                                    ground cut round each glyph) and the thin blades of light down
                                    in the joints between the squares (red 0.5).
    drawer_void_w, drawer_void_e, drawer_lid_w, drawer_lid_e
                                    the drawers, shut: a front with the case's panel and a
                                    lozenge pull, thin walls, and a baize floor at PLINTH_TOP.
                                    Each slides out along x by `meta.drawer.travel`.
    clasp                           the hasp on the front of Void's half, hanging open. It turns
                                    about the x axis through `meta.clasp.pivot`; at `meta.clasp.shut`
                                    radians it stands up over the seam and holds the lid.

Game space throughout: one unit is one square, x right, y up, Ivory at +z.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib  # noqa: E402
from lib import box, cylinder, gb  # noqa: E402

V = Vector
HERE = os.path.dirname(os.path.abspath(__file__))

# The board, from the middle out. The squares are set in a field FIELD each way from the
# middle, and the rail rises round it to RIM_TOP; HALF is the outside of the case.
TILE = 0.992                # a slab; the hairline left between slabs is the joint
TILE_THICK = 0.26
TILE_BEVEL = 0.008
FIELD = 4.0
RIM_TOP = 0.10
HALF = 4.80
FACE = 4.745                # the faces under the rail stand back this far
BOTTOM = -1.0
SEAM = 0.003                # each half stops this far short of the hinge line

# The panels sunk in the faces, the lozenge in each, and the drawers.
PANEL_TOP = -0.35
PANEL_BOT = -0.81
PANEL_MID = (PANEL_TOP + PANEL_BOT) / 2
PANEL_SINK = 0.045
DRAWER_IN = 3.54            # how far in the drawer's hole reaches
DRAWER_NEAR = 0.11          # its ends, along z, from the hinge line
DRAWER_FAR = 4.49
DRAWER_TOP = -0.29
DRAWER_FLOOR = -0.67        # the baize, where a taken stone stands (layout's PLINTH_TOP)
DRAWER_WALL = -0.42         # the top of the tray's walls
TRAVEL = 1.2                # how far a drawer comes out

# The hinge at each end of the seam: a small barrel lying in a notch on the flat of the rim, its
# leaves let into the rim either side of the seam. Nothing of it stands higher than RIM_TOP + HINGE_R.
HINGE_R = 0.03
HINGE_FROM, HINGE_TO = 4.13, 4.47
LEAF_FROM, LEAF_TO = 4.14, 4.44
LEAF_WIDE = 0.15                # out from the seam
LEAF_THICK = 0.008
CLASP_PIVOT = (-0.215, -(HALF + 0.045))      # (y, z)

WOOD, BRASS, BAIZE = 0.0, 0.5, 1.0


# ---------------------------------------------------------------------------
# Solids
# ---------------------------------------------------------------------------

def solid(points: list[Vector], faces: list[list[int]], name: str = "solid") -> bpy.types.Mesh:
    """A closed mesh from game-space points and faces given as indices into them."""
    bm = bmesh.new()
    verts = [bm.verts.new(gb(p.x, p.y, p.z)) for p in points]
    for f in faces:
        bm.faces.new([verts[i] for i in f])
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def loft(rings: list[list[Vector]], closed: bool = True) -> bpy.types.Mesh:
    """A solid through a stack of rings of equal length, capped at both ends."""
    pts = [p for r in rings for p in r]
    n = len(rings[0])
    faces = [list(range(n)), list(range(len(pts) - n, len(pts)))[::-1]]
    for k in range(len(rings) - 1):
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            faces.append([k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i])
    return solid(pts, faces, "loft")


def hull(points: list[Vector]) -> bpy.types.Mesh:
    """The convex solid round a set of points."""
    bm = bmesh.new()
    for p in points:
        bm.verts.new(gb(p.x, p.y, p.z))
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    out = bmesh.ops.convex_hull(bm, input=bm.verts[:], use_existing_faces=False)
    stray = list({g for g in out["geom_interior"] + out["geom_unused"] if isinstance(g, bmesh.types.BMVert)})
    if stray:
        bmesh.ops.delete(bm, geom=stray, context="VERTS")
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=bm.verts[:], edges=bm.edges[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new("hull")
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def sweep(profile: list[tuple[float, float]], seam: float = SEAM) -> bpy.types.Mesh:
    """A moulding run round the three outer sides of Void's half, mitred at the corners and cut
    square at the hinge line. `profile` lists (distance out from the middle, height) round the
    moulding's section."""
    rings = []
    for d, y in profile:
        rings.append([V((-d, y, -seam)), V((-d, y, -d)), V((d, y, -d)), V((d, y, -seam))])
    n = len(profile)
    pts = [p for r in rings for p in r]
    faces = [[k * 4 for k in range(n)], [k * 4 + 3 for k in range(n)][::-1]]
    for k in range(n):
        k2 = (k + 1) % n
        for j in range(3):
            faces.append([k * 4 + j, k * 4 + j + 1, k2 * 4 + j + 1, k2 * 4 + j])
    return solid(pts, faces, "sweep")


def prism(outline: list[tuple[float, float]], place, d0: float, d1: float) -> bpy.types.Mesh:
    """A plate cut to an outline drawn on a face: `outline` lists (along, up) points, and `place`
    turns (along, up, depth into the face) into a game-space point. Runs from depth d0 to d1."""
    n = len(outline)
    pts = [place(a, y, d0) for a, y in outline] + [place(a, y, d1) for a, y in outline]
    faces = [list(range(n)), list(range(n, 2 * n))[::-1]]
    for i in range(n):
        j = (i + 1) % n
        faces.append([i, j, n + j, n + i])
    return solid(pts, faces, "prism")


def frustum(outline: list[tuple[float, float]], inset: float, place, d0: float, d1: float) -> bpy.types.Mesh:
    """A raised field: a convex outline at depth d0, and the same outline drawn `inset` smaller
    at depth d1, joined by bevelled sides."""
    cx = sum(a for a, _ in outline) / len(outline)
    cy = sum(y for _, y in outline) / len(outline)
    inner = []
    for a, y in outline:
        da, dy = a - cx, y - cy
        k = math.hypot(da, dy)
        inner.append((a - da / k * inset, y - dy / k * inset))
    return hull([place(a, y, d0) for a, y in outline] + [place(a, y, d1) for a, y in inner])


def mirrored(mesh: bpy.types.Mesh, sx: float = 1.0, sz: float = 1.0) -> bpy.types.Mesh:
    """Mirror a mesh across x = 0 and/or z = 0 (game space), keeping its faces turned outward."""
    mesh.transform(Matrix.Diagonal((sx, sz, 1.0, 1.0)))     # Blender's y is game -z
    bm = bmesh.new()
    bm.from_mesh(mesh)
    if sx * sz < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def tube(r: float, a: Vector, b: Vector, sides: int = 16) -> bpy.types.Mesh:
    return cylinder(r, a, b, sides)


# Faces of Void's half, as places for `prism`: along runs left to right as you face it.
def front(a: float, y: float, depth: float) -> Vector:
    """The face toward Void (z = -FACE), seen from outside."""
    return V((a, y, -(FACE - depth)))


def east(a: float, y: float, depth: float, face: float = FACE) -> Vector:
    """The +x face of Void's half, seen from outside: along runs from the far corner toward the seam."""
    return V((face - depth, y, -a))


# ---------------------------------------------------------------------------
# Finishing
# ---------------------------------------------------------------------------

SHARP = 32.0


def finish(mesh: bpy.types.Mesh, stuff, bevel: float = 0.008, uv_scale: float = 0.5,
           uv_offset=(0.0, 0.0)) -> bpy.types.Mesh:
    """Chamfer the outward corners of a solid and write its data colours and tiling UVs.
    `stuff` is what it is made of (WOOD, BRASS, BAIZE), or a function of a face's centre that
    says. The grain of the walnut follows the rail a face belongs to."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.0), verts=bm.verts[:], edges=bm.edges[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    col, uv0, _ = lib._layers(bm)
    chamfers: set = set()
    if bevel > 0:
        hard = [e for e in bm.edges if len(e.link_faces) == 2 and e.is_convex
                and e.calc_face_angle(0.0) > math.radians(SHARP)]
        if hard:
            result = bmesh.ops.bevel(bm, geom=hard, offset=bevel, offset_type="OFFSET", segments=1, profile=0.5,
                                     affect="EDGES", clamp_overlap=True)
            chamfers = set(result["faces"])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    for f in bm.faces:
        c = f.calc_center_median()
        g = V((c.x, c.z, -c.y))
        m = stuff(g) if callable(stuff) else stuff
        edge = 1.0 if f in chamfers else 0.0
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        along_z = abs(g.x) > abs(g.z)          # on a side rail, whose grain runs along z
        for loop in f.loops:
            loop[col] = (m, 0.0, edge, 0.0)
            p = loop.vert.co
            if az >= ax and az >= ay:          # facing up or down
                u, v = (p.y, p.x) if along_z else (p.x, p.y)
            elif ay >= ax:                     # facing along z: the grain runs along x
                u, v = p.x, p.z
            else:                              # facing along x: the grain runs along z
                u, v = p.y, p.z
            loop[uv0].uv = (u * uv_scale + uv_offset[0], v * uv_scale + uv_offset[1])
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def make_object(mesh: bpy.types.Mesh, name: str) -> bpy.types.Object:
    return lib.make_object(mesh, name)


def strip(mesh: bpy.types.Mesh, hidden) -> bpy.types.Mesh:
    """Delete the faces for which `hidden(centre, normal)` (game space) is true."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    doomed = []
    for f in bm.faces:
        c = f.calc_center_median()
        n = f.normal
        if hidden(V((c.x, c.z, -c.y)), V((n.x, n.z, -n.y))):
            doomed.append(f)
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    bm.to_mesh(mesh)
    bm.free()
    return mesh


# ---------------------------------------------------------------------------
# The panel, the lozenge and the corner brass
# ---------------------------------------------------------------------------

def notched(a0: float, a1: float, top: float, bot: float, tab: float = 0.17, notch: float = 0.09) -> list[tuple[float, float]]:
    """The outline of a long sunk panel whose ends run out into a narrower tab, and each tab is cut
    in a fishtail: two points with a notch between them."""
    h = top - bot
    mid = (top + bot) / 2
    t = 0.27 * h
    left = [(a0, bot), (a0, mid - t), (a0 - tab, mid - t - 0.03), (a0 - tab + notch, mid),
            (a0 - tab, mid + t + 0.03), (a0, mid + t), (a0, top)]
    right = [(a0 + a1 - a, y) for a, y in reversed(left)]
    return left + right


def field_outline(a0: float, a1: float, top: float, bot: float) -> list[tuple[float, float]]:
    """The raised field inside a panel: a long hexagon, pointed at both ends."""
    mid = (top + bot) / 2
    return [(a0, mid), (a0 + 0.16, bot), (a1 - 0.16, bot), (a1, mid), (a1 - 0.16, top), (a0 + 0.16, top)]


def diamond(cx: float, cy: float, w: float, h: float) -> list[tuple[float, float]]:
    return [(cx, cy - h), (cx + w, cy), (cx, cy + h), (cx - w, cy)]


def shrink(outline: list[tuple[float, float]], by: float) -> list[tuple[float, float]]:
    """A convex outline with every edge moved in by the same distance, so that a bevel round it is
    the same width all the way round."""
    n = len(outline)
    cx = sum(a for a, _ in outline) / n
    cy = sum(y for _, y in outline) / n
    lines = []
    for i in range(n):
        (a0, y0), (a1, y1) = outline[i], outline[(i + 1) % n]
        da, dy = a1 - a0, y1 - y0
        k = math.hypot(da, dy)
        na, ny = -dy / k, da / k
        if na * (cx - a0) + ny * (cy - y0) < 0:
            na, ny = -na, -ny
        lines.append(((a0 + na * by, y0 + ny * by), (da, dy)))
    out = []
    for i in range(n):
        (pa, py), (ua, uy) = lines[i - 1]
        (qa, qy), (va, vy) = lines[i]
        t = ((qa - pa) * vy - (qy - py) * va) / (ua * vy - uy * va)
        out.append((pa + ua * t, py + uy * t))
    return out


def bevelled(outline: list[tuple[float, float]], by: float, place, d0: float, d1: float) -> bpy.types.Mesh:
    """A convex plate: `outline` at depth d0, and drawn `by` smaller at depth d1, joined by a bevel
    of even width."""
    return hull([place(a, y, d0) for a, y in outline] + [place(a, y, d1) for a, y in shrink(outline, by)])


def panel(place, a0: float, a1: float, top: float = PANEL_TOP, bot: float = PANEL_BOT,
          sink: float = PANEL_SINK) -> tuple[bpy.types.Mesh, bpy.types.Mesh]:
    """A sunk panel with a raised, bevelled field: (cutter, field)."""
    cutter = prism(notched(a0, a1, top, bot), place, -0.2, sink)
    fa0, fa1 = a0 + 0.12, a1 - 0.12
    field = frustum(field_outline(fa0, fa1, top - 0.075, bot + 0.075), 0.05, place, sink + 0.01, 0.018)
    return cutter, field


def lozenge(place, a: float, y: float, proud: float = 0.06, boss: float = 0.055, pull: bool = False):
    """The lozenge on a face: a walnut plate, bevelled to a smaller face, with a brass ring and a
    round boss in it. Returns (wood, brass)."""
    w, h = (0.46, 0.2) if not pull else (0.4, 0.18)
    plate = frustum(diamond(a, y, w, h), 0.05, place, 0.03, -proud)
    ring_r, ring_w = 0.13, 0.032
    centre = place(a, y, -proud)
    out = (place(a, y, -proud - 1.0) - centre).normalized()
    ring = lib.subtract(tube(ring_r, centre - out * 0.01, centre + out * 0.022, 24),
                        [tube(ring_r - ring_w, centre - out * 0.05, centre + out * 0.06, 24)])
    dome = []
    for r, lift in ((0.085, -0.01), (0.083, 0.02), (0.07, boss * 0.6), (0.042, boss * 0.9), (0.0, boss)):
        for i in range(16):
            t = i * math.tau / 16
            side = out.orthogonal().normalized()
            up = out.cross(side)
            dome.append(centre + out * lift + (side * math.cos(t) + up * math.sin(t)) * r)
    return plate, [ring, hull(dome)]


def under(a: float, y: float, depth: float) -> Vector:
    """The lid's outer face, as a place for `prism`: open, the underside of the lid's half, which
    is the top of the case when it is shut. `a` runs along x, `y` out from the hinge line, and
    depth is up into the wood. Nothing stands below it (depth < 0): open, the lid lies on the altar."""
    return V((a, BOTTOM + depth, -y))


LID_BAND = 0.4                  # the plain walnut round the edge of the lid's face
LID_MID = HALF / 2              # the middle of the lid's face, out from the hinge line
LID_STEPS = ((0.0, 0.03), (0.1, 0.06), (0.2, 0.09))     # the moulding: (how far in, how deep)


def lid_face() -> tuple[list[bpy.types.Mesh], list[bpy.types.Mesh], list[bpy.types.Mesh]]:
    """The top of the shut case, in the language of the side panels: a sunk panel with fishtail
    ends, stepped down to its ground through a moulding; on the ground a raised field, long and
    pointed, with a broad bevel; on the field a brass lozenge with a ring and a plain boss; and a
    brass cap let in flush at each corner, its arms ending in points. Everything is let in: the
    face is flat at BOTTOM, so the lid lies flat on the altar. Returns (cuts, wood, brass)."""
    cuts, wood, brass = [], [], []
    a0, a1 = -(HALF - LID_BAND - 0.3), HALF - LID_BAND - 0.3
    top, bot = HALF - LID_BAND, LID_BAND
    for step, depth in LID_STEPS:
        cuts.append(prism(notched(a0 + step, a1 - step, top - step, bot + step, tab=0.3 - 0.02 * step / 0.1,
                                  notch=0.16), under, -0.2, depth))
    ground = LID_STEPS[-1][1]
    fa, ft, fb = 3.55, top - 0.42, bot + 0.42
    field = [(-fa, LID_MID), (-fa + 0.55, fb), (fa - 0.55, fb), (fa, LID_MID), (fa - 0.55, ft), (-fa + 0.55, ft)]
    face = ground - 0.05
    wood.append(bevelled(field, 0.16, under, ground + 0.005, face))

    # The lozenge, big enough to be read from across the chapel.
    plate = diamond(0.0, LID_MID, 0.8, 0.38)
    brass.append(bevelled(plate, 0.07, under, face + 0.005, 0.016))
    centre = under(0.0, LID_MID, 0.016)
    down = V((0.0, -1.0, 0.0))
    ring_r, ring_w = 0.23, 0.05
    brass.append(lib.subtract(tube(ring_r, centre - down * 0.006, centre + down * 0.009, 32),
                              [tube(ring_r - ring_w, centre - down * 0.03, centre + down * 0.03, 32)]))
    dome = []
    for r, lift in ((0.15, -0.006), (0.145, 0.004), (0.12, 0.010), (0.07, 0.014), (0.0, 0.016)):
        for i in range(20):
            t = i * math.tau / 20
            dome.append(centre + down * lift + V((math.cos(t) * r, 0.0, math.sin(t) * r)))
    brass.append(hull(dome))

    # The corner caps: a square on the corner and an arm along each edge, ending in a point. Let in
    # no deeper than the floor under the drawers allows.
    sink, edge = 0.012, HALF - 0.012
    for ca in (-edge, edge):
        for cy in (0.012 + SEAM, HALF - 0.012):
            ia = -1.0 if ca > 0 else 1.0
            iy = 1.0 if cy < LID_MID else -1.0
            local = lambda p, q, d, ca=ca, cy=cy, ia=ia, iy=iy: under(ca + ia * p, cy + iy * q, d)  # noqa: E731
            square = [(0.0, 0.0), (0.42, 0.0), (0.42, 0.42), (0.0, 0.42)]
            arms = [
                [(0.40, 0.0), (0.98, 0.0), (1.24, 0.13), (0.98, 0.26), (0.40, 0.26)],
                [(0.0, 0.40), (0.26, 0.40), (0.26, 0.98), (0.13, 1.24), (0.0, 0.98)],
            ]
            for outline in [square] + arms:
                cuts.append(prism(outline, local, -0.2, sink + 0.0005))
            caps = [bevelled(outline, 0.012, local, sink, 0.0) for outline in arms]
            # The square rises to a low point, so that the corner catches the light on four faces.
            caps.append(hull([local(p, q, sink) for p, q in square] + [local(p, q, 0.006) for p, q in shrink(square, 0.012)]
                             + [local(0.21, 0.21, 0.0)]))
            brass.append(lib.union(caps))
    return cuts, wood, brass


def rim_cap_profile() -> list[tuple[float, float]]:
    """The section of the brass that sheathes the rail at a corner: a thin skin over the rim, its
    slope and its lip, standing a hair proud of the walnut. Its top is raised to a low ridge down
    the middle of the rim, so that it is faceted, and the facets meet in a crease along the mitre."""
    return [(4.16, 0.092), (4.16, 0.104), (4.31, 0.117), (4.464, 0.107), (4.807, -0.087), (4.807, -0.158),
            (4.786, -0.158), (4.786, -0.092), (4.458, 0.092)]


def cap_plan(sx: float, sz: float) -> bpy.types.Mesh:
    """The plan of a corner cap: a square at the corner whose two inner edges end in forks."""
    reach, fork, mid = 3.78, 4.02, 4.45
    pts = [(-4.95, -4.95), (-reach, -4.95), (-fork, -mid), (-reach, -4.08), (-reach, -reach),
           (-4.08, -reach), (-mid, -fork), (-4.95, -reach)]
    rings = [[V((-sx * x, yy, -sz * z)) for x, z in pts] for yy in (-0.4, 0.3)]
    return loft(rings)


def kite_shield(sx: float, sz: float) -> list[bpy.types.Mesh]:
    """The brass that folds round an outer corner of the case below the rail: a kite on each of
    the two faces, meeting on the corner, and a pyramid stud standing out over the corner."""
    kite = [(0.0, -0.16), (0.30, -0.40), (0.22, -0.82), (0.0, -0.995)]
    out = HALF + 0.022
    back = HALF - 0.08
    on_z = [V((sx * (out - s), y, sz * out)) for s, y in kite] + [V((sx * (out - s), y, sz * back)) for s, y in kite]
    on_x = [V((sx * out, y, sz * (out - s))) for s, y in kite] + [V((sx * back, y, sz * (out - s))) for s, y in kite]
    plates = [hull(on_z), hull(on_x)]
    c = V((sx * out, -0.47, sz * out))
    stud = hull([
        c + V((0, 0.17, 0)), c + V((0, -0.17, 0)),
        c + V((-sx * 0.2, 0, 0)), c + V((0, 0, -sz * 0.2)),
        c + V((sx * 0.06, 0, sz * 0.06)),
        c + V((-sx * 0.1, 0, -sz * 0.1)),
    ])
    return [lib.union(plates), stud]


# ---------------------------------------------------------------------------
# The halves
# ---------------------------------------------------------------------------

def rail_profile() -> list[tuple[float, float]]:
    """The rail's section: up from the field over a rounded edge, across the wide flat rim, down a
    slope to a lip, and back under it to the face."""
    pts = [(FIELD, -0.30)]
    for i in range(5):
        t = math.pi - i * (math.pi / 2) / 4
        pts.append((FIELD + 0.1 + 0.1 * math.cos(t), 0.1 * math.sin(t)))
    pts += [(4.46, RIM_TOP), (HALF, -0.09), (HALF, -0.15), (FACE, -0.19), (FACE, -0.30)]
    return pts


def hinge_knuckles(own: int) -> list[bpy.types.Mesh]:
    """The barrel of the hinge at each end of the seam: five knuckles, alternating between the
    halves, on a pin whose round heads close its ends. `own` 0 takes the first, third and fifth
    of each and the pin's heads (Void), 1 the second and fourth (the lid)."""
    step = (HINGE_TO - HINGE_FROM) / 5
    meshes = []
    for sx in (-1, 1):
        for i in range(5):
            if (i % 2 == 1) != (own == 1):
                continue
            a, b = HINGE_FROM + i * step + 0.002, HINGE_FROM + (i + 1) * step - 0.002
            meshes.append(tube(HINGE_R, V((sx * a, RIM_TOP, 0.0)), V((sx * b, RIM_TOP, 0.0)), 18))
        if own == 0:
            for a, out in ((HINGE_FROM, -1), (HINGE_TO, 1)):
                # A pin's head: a low dome a little wider than the barrel.
                ring = lambda r, d: [V((sx * (a + out * d), RIM_TOP + r * math.cos(t), r * math.sin(t)))  # noqa: E731
                                     for t in (i * math.tau / 16 for i in range(16))]
                meshes.append(hull(ring(HINGE_R + 0.004, 0.0) + ring(HINGE_R * 0.75, 0.008) + ring(HINGE_R * 0.35, 0.012)))
    return meshes


def half_body(lid: bool) -> tuple[bpy.types.Mesh, bpy.types.Mesh]:
    """One half of the case, built as Void's (z < 0); the lid is mirrored afterwards.
    Returns (walnut, brass)."""
    body = lib.union([
        sweep(rail_profile()),
        sweep([(4.5, -0.30), (FACE, -0.30), (FACE, -0.905), (HALF, -0.935), (HALF, BOTTOM), (4.5, BOTTOM)]),
        box(9.2, -0.26 - BOTTOM, 4.6 - SEAM, y=BOTTOM, z=-(4.6 + SEAM) / 2),
    ])

    cuts = []
    # The drawers' holes.
    for sx in (-1, 1):
        cuts.append(box(HALF + 0.05 - DRAWER_IN, DRAWER_TOP - (DRAWER_FLOOR - 0.17), DRAWER_FAR - DRAWER_NEAR,
                        y=DRAWER_FLOOR - 0.17, x=sx * (DRAWER_IN + HALF + 0.05) / 2, z=-(DRAWER_FAR + DRAWER_NEAR) / 2))
        inner = FACE - 0.1
        cuts.append(box(HALF + 0.05 - inner, DRAWER_TOP - (BOTTOM + 0.015), DRAWER_FAR - DRAWER_NEAR,
                        y=BOTTOM + 0.015, x=sx * (inner + HALF + 0.05) / 2, z=-(DRAWER_FAR + DRAWER_NEAR) / 2))
    # The panel in the front face, and the notch the hinge barrel lies in.
    front_cut, front_field = panel(front, -4.1, 4.1)
    cuts.append(front_cut)
    for sx in (-1, 1):
        cuts.append(tube(HINGE_R + 0.005, V((sx * (HINGE_FROM - 0.025), RIM_TOP, 0.0)), V((sx * (HINGE_TO + 0.025), RIM_TOP, 0.0)), 18))
        # The pocket the leaf is let into, flush with the rim.
        cuts.append(box(LEAF_TO - LEAF_FROM + 0.006, 0.03, LEAF_WIDE + 0.006, y=RIM_TOP - LEAF_THICK - 0.0005,
                        x=sx * (LEAF_FROM + LEAF_TO) / 2, z=-(SEAM + LEAF_WIDE / 2)))
    if lid:
        lid_cuts, lid_wood, lid_brass = lid_face()
        cuts.extend(lid_cuts)
    body = lib.subtract(body, cuts)

    wood = [body, front_field]
    plate, metal = lozenge(front, 0.0, PANEL_MID)
    wood.append(plate)
    brass = list(metal)
    if lid:
        wood.extend(lid_wood)
        brass.extend(lid_brass)
    else:
        # The clasp's hinge, under the lip in the middle of the front.
        y, z = CLASP_PIVOT
        brass.append(box(0.36, 0.07, 0.07, cy=y + 0.005, z=-(FACE + 0.03)))
        for sx in (-1, 1):
            brass.append(tube(0.032, V((sx * 0.105, y, z)), V((sx * 0.17, y, z)), 14))

    # Brass at the corners and along the hinge.
    caps = lib.intersect(sweep(rim_cap_profile()), lib.union([cap_plan(-1, -1), cap_plan(1, -1)]))
    brass.append(caps)
    for sx in (-1, 1):
        brass.extend(kite_shield(sx, -1))
        # The hinge's leaf, let in flush, and its two screws.
        leaf = box(LEAF_TO - LEAF_FROM, LEAF_THICK, LEAF_WIDE, y=RIM_TOP - LEAF_THICK - 0.0003,
                   x=sx * (LEAF_FROM + LEAF_TO) / 2, z=-(SEAM + LEAF_WIDE / 2))
        brass.append(leaf)
        for a in (LEAF_FROM + 0.06, LEAF_TO - 0.06):
            brass.append(hull([V((sx * a + r * math.cos(t), RIM_TOP - 0.001 + h, -(SEAM + LEAF_WIDE * 0.62) + r * math.sin(t)))
                               for r, h in ((0.017, 0.0), (0.012, 0.004), (0.005, 0.006))
                               for t in (i * math.tau / 10 for i in range(10))]))
    brass.extend(hinge_knuckles(1 if lid else 0))
    return wood, brass


def build_half(lid: bool) -> bpy.types.Object:
    wood, brass = half_body(lid)
    parts = []
    for i, m in enumerate(wood):
        parts.append(finish(m, WOOD, bevel=0.009 if i == 0 else 0.006, uv_scale=0.42,
                            uv_offset=(0.31 * i + (0.5 if lid else 0.0), 0.17 * i)))
    for i, m in enumerate(brass):
        parts.append(finish(m, BRASS, bevel=0.004, uv_scale=1.0, uv_offset=(0.23 * i, 0.41 * i)))
    mesh = lib.join_raw(parts, "half")
    if lid:
        mirrored(mesh, sz=-1.0)
    else:
        # Void's half never leaves the altar: its underside is never seen.
        strip(mesh, lambda c, n: n.y < -0.9 and c.y < BOTTOM + 0.001)
    return make_object(mesh, "lid_frame" if lid else "void_frame")


# ---------------------------------------------------------------------------
# Drawers
# ---------------------------------------------------------------------------

def drawer_meshes() -> list[tuple[bpy.types.Mesh, float]]:
    """The east drawer of Void's half, shut: (mesh, stuff) pairs."""
    near, far = DRAWER_NEAR + 0.01, DRAWER_FAR - 0.01
    length = far - near
    zc = -(near + far) / 2
    back = DRAWER_IN + 0.02
    front_in = FACE - 0.08
    wood = [
        # The front, with a lip at its foot that carries on the base moulding.
        box(0.08, -0.295 - (BOTTOM + 0.025), length, y=BOTTOM + 0.025, x=FACE - 0.04, z=zc),
        box(0.06, 0.07, length, y=BOTTOM + 0.025, x=FACE + 0.025, z=zc),
        # The floor, the two ends and the back.
        box(front_in - back, 0.1, length, y=DRAWER_FLOOR - 0.13, x=(front_in + back) / 2, z=zc),
        box(front_in - back, DRAWER_WALL - (DRAWER_FLOOR - 0.03), 0.04, y=DRAWER_FLOOR - 0.03,
            x=(front_in + back) / 2, z=-(near + 0.02)),
        box(front_in - back, DRAWER_WALL - (DRAWER_FLOOR - 0.03), 0.04, y=DRAWER_FLOOR - 0.03,
            x=(front_in + back) / 2, z=-(far - 0.02)),
        box(0.04, DRAWER_WALL - (DRAWER_FLOOR - 0.03), length, y=DRAWER_FLOOR - 0.03, x=back + 0.02, z=zc),
    ]
    body = lib.union(wood)
    place = lambda a, y, d: east(a, y, d)   # noqa: E731
    cut, field = panel(place, near + 0.28, far - 0.28, sink=0.03)
    body = lib.subtract(body, [cut])
    plate, metal = lozenge(place, (near + far) / 2, PANEL_MID, proud=0.07, boss=0.075, pull=True)
    baize = box(front_in - back - 0.08, 0.03, length - 0.08, y=DRAWER_FLOOR - 0.03, x=(front_in + back) / 2, z=zc)
    out = [(body, WOOD), (field, WOOD), (plate, WOOD), (baize, BAIZE)]
    out += [(m, BRASS) for m in metal]
    return out


def build_drawer(name: str, sx: float, sz: float) -> bpy.types.Object:
    parts = []
    for i, (m, stuff) in enumerate(drawer_meshes()):
        if sx < 0 or sz > 0:
            mirrored(m, sx=sx, sz=-sz)
        bevel = 0.004 if stuff == BRASS else (0.0 if stuff == BAIZE else 0.006)
        scale = 1.0 if stuff == BRASS else (0.8 if stuff == BAIZE else 0.42)
        parts.append(finish(m, stuff, bevel=bevel, uv_scale=scale, uv_offset=(0.29 * i + sx * 0.2, 0.37 * i + sz * 0.3)))
    return make_object(lib.join_raw(parts, name), name)


def build_clasp() -> bpy.types.Object:
    """The hasp, hanging open: a brass strap from its knuckle under the lip down over the boss in
    the lozenge, with a lozenge-shaped end and a hole the boss stands through."""
    y0, z0 = CLASP_PIVOT
    outline = [(-0.065, y0), (0.065, y0), (0.065, PANEL_MID + 0.16), (0.15, PANEL_MID),
               (0.065, PANEL_MID - 0.15), (0.0, PANEL_MID - 0.22), (-0.065, PANEL_MID - 0.15),
               (-0.15, PANEL_MID), (-0.065, PANEL_MID + 0.16)]
    place = lambda a, y, d: V((a, y, z0 + d))  # noqa: E731
    strap = prism(outline, place, -0.012, 0.012)
    strap = lib.subtract(strap, [tube(0.075, V((0, PANEL_MID, z0 - 0.1)), V((0, PANEL_MID, z0 + 0.1)), 24)])
    knuckle = tube(0.032, V((-0.1, y0, z0)), V((0.1, y0, z0)), 14)
    mesh = lib.union([strap, knuckle])
    finish(mesh, BRASS, bevel=0.004, uv_scale=1.0)
    return make_object(mesh, "clasp")


# ---------------------------------------------------------------------------
# Squares and inlay
# ---------------------------------------------------------------------------

def build_tiles() -> list[bpy.types.Object]:
    rng = random.Random(64)
    groups: dict[str, list[bpy.types.Mesh]] = {k: [] for k in
                                                ("void_tiles_light", "void_tiles_dark", "lid_tiles_light", "lid_tiles_dark")}
    for rank in range(8):
        for file in range(8):
            index = rank * 8 + file
            z = 3.5 - rank
            mesh = box(TILE, TILE_THICK, TILE, y=-TILE_THICK, x=file - 3.5, z=z)
            lib.finish_stone(mesh, 0, bevel=TILE_BEVEL, red=index / 63.0, uv_scale=1 / 2.3,
                             uv_offset=(rng.random(), rng.random()), uv_turns=rng.randrange(4))
            half = "lid" if z > 0 else "void"
            shade = "light" if (file + rank) % 2 == 1 else "dark"
            groups[f"{half}_tiles_{shade}"].append(mesh)
    return [make_object(lib.join_raw(ms, name), name) for name, ms in groups.items()]


def glyph(body: str, font: bpy.types.VectorFont, size: float, depth: float, offset: float = 0.0) -> bpy.types.Mesh:
    """A flat extruded glyph centred on the origin, lying on Blender's XY plane with its top at
    z = depth. `offset` fattens its outline by that much all round."""
    curve = bpy.data.curves.new("glyph", "FONT")
    curve.body = body
    curve.font = font
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.offset = offset
    curve.extrude = depth / 2
    curve.resolution_u = 3
    obj = bpy.data.objects.new("glyph", curve)
    bpy.context.scene.collection.objects.link(obj)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(curve)
    for v in mesh.vertices:
        v.co.z += depth / 2
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    return mesh


RIM_MID = (4.1 + 4.46) / 2      # the middle of the flat of the rim, where the coordinates run


def build_inlay(lid: bool) -> bpy.types.Object:
    """The coordinates let into the rim of one half, upright for the player who sits at that edge
    (and the ranks upright for the player on whose left they run), and the blades of light down
    in the joints between its squares."""
    s = 1.0 if lid else -1.0
    parts = []
    # Blades down in the joints, their tops well under the surface.
    top, foot = -0.012, -0.08
    w = 0.005
    for x in range(-3, 4):
        parts.append(box(w, top - foot, 4.0 - 0.01, y=foot, x=float(x), z=s * 2.0))
    for z in (1.0, 2.0, 3.0):
        parts.append(box(8.0 - 0.01, top - foot - 0.001, w, y=foot, z=s * z))
    blades = lib.union(parts)
    lib.finish_stone(blades, 0, bevel=0.0, uv_scale=1.0, red=BRASS)

    font = bpy.data.fonts.load(os.path.join(HERE, "fonts", "DMMono-Medium.ttf"))
    glyphs = []
    for i in range(8):
        along = i - 3.5
        letter = "abcdefgh"[i]
        digit = str(i + 1)
        rank_z = -along
        placements = [(letter, along, s * RIM_MID, 0.0 if lid else math.pi)]
        if (rank_z > 0) == lid:
            placements += [(digit, -RIM_MID, rank_z, 0.0), (digit, RIM_MID, rank_z, math.pi)]
        for body, x, z, turn in placements:
            place = Matrix.Translation(gb(x, RIM_TOP, z)) @ Matrix.Rotation(turn, 4, "Z")
            ground = lib.transform(glyph(body, font, 0.27, 0.002, offset=0.009), place)
            glyphs.append(lib.finish_stone(ground, 0, bevel=0.0, uv_scale=1.0, red=1.0))
            gilt = lib.transform(glyph(body, font, 0.27, 0.004), place)
            glyphs.append(lib.finish_stone(gilt, 0, bevel=0.0, uv_scale=1.0, uv_offset=(0.13 * i, 0.29 * i), red=0.0))
    bpy.data.fonts.remove(font)
    name = "lid_inlay" if lid else "void_inlay"
    return make_object(lib.join_raw([blades, *glyphs], name), name)


# ---------------------------------------------------------------------------
# Baking
# ---------------------------------------------------------------------------

CELLS = {
    "void_frame": (0.0, 0.36, 0.5, 1.0),
    "lid_frame": (0.5, 0.36, 1.0, 1.0),
    "drawer_void_w": (0.0, 0.0, 0.22, 0.36),
    "drawer_void_e": (0.22, 0.0, 0.44, 0.36),
    "drawer_lid_w": (0.44, 0.0, 0.66, 0.36),
    "drawer_lid_e": (0.66, 0.0, 0.88, 0.36),
    "clasp": (0.88, 0.0, 1.0, 0.12),
}


def unwrap(obj: bpy.types.Object, cell: tuple[float, float, float, float], margin: float = 0.004) -> None:
    mesh = obj.data
    mesh.uv_layers.active = mesh.uv_layers[lib.UV_UNIQUE]
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60.0), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, rotate_method="CARDINAL", shape_method="CONCAVE",
                            margin_method="FRACTION", margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    u0, v0, u1, v1 = cell
    pad = 0.006
    for d in mesh.uv_layers[lib.UV_UNIQUE].data:
        d.uv = (u0 + (pad + d.uv[0] * (1 - 2 * pad)) * (u1 - u0), v0 + (pad + d.uv[1] * (1 - 2 * pad)) * (v1 - v0))
    mesh.uv_layers.active = mesh.uv_layers[lib.UV_TILE]


def bake(baked: list[bpy.types.Object], drawers: dict[str, bpy.types.Object], out: str, size: int) -> None:
    """Ambient occlusion with the case open and its drawers out, as it stands through a game. There
    is no altar under it: the lid's underside is on top when the case is shut, and the engine's
    own shadows set the case down on the altar."""
    for name, obj in drawers.items():
        obj.location.x += TRAVEL * (1 if name.endswith("_e") else -1)
    image = bpy.data.images.new("case_ao", size, size, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    lib.bake_ao(baked, image, floor_y=None, together=True, distance=0.45, margin=8)
    ao = lib.image_pixels(image)[..., 0]
    for obj in drawers.values():
        obj.location.x = 0.0
    lib.save_rgb_jpeg(np.repeat(np.clip(ao, 0, 1)[..., None], 3, axis=-1), os.path.join(out, "tex", "case_ao.jpg"))
    bpy.data.images.remove(image)


# ---------------------------------------------------------------------------
# Looking at it
# ---------------------------------------------------------------------------

def _image(path: str, colour: bool = True) -> bpy.types.Image:
    img = bpy.data.images.load(path, check_existing=True)
    if not colour:
        img.colorspace_settings.name = "Non-Color"
    return img


def _textured(nt, tex_dir: str, name: str, uv, scale: float = 1.0):
    """(colour, roughness, normal) sockets for one of the tiling textures."""
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = _image(os.path.join(tex_dir, f"{name}_albedo.jpg"))
    orm = nt.nodes.new("ShaderNodeTexImage")
    orm.image = _image(os.path.join(tex_dir, f"{name}_orm.jpg"), False)
    nrm = nt.nodes.new("ShaderNodeTexImage")
    nrm.image = _image(os.path.join(tex_dir, f"{name}_normal.jpg"), False)
    for t in (img, orm, nrm):
        nt.links.new(uv, t.inputs["Vector"])
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.uv_map = lib.UV_TILE
    nmap.inputs["Strength"].default_value = 0.6
    nt.links.new(nrm.outputs["Color"], nmap.inputs["Color"])
    return img.outputs["Color"], sep.outputs["Green"], nmap.outputs["Normal"]


def case_material(tex_dir: str, clay: bool) -> bpy.types.Material:
    """Walnut, brass or baize by the red of the data colour."""
    mat = bpy.data.materials.new("case")
    mat.use_nodes = True
    nt = mat.node_tree
    nodes = nt.nodes
    out = nodes["Material Output"]
    nodes.remove(nodes["Principled BSDF"])
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = lib.COLOR
    sep = nodes.new("ShaderNodeSeparateColor")
    nt.links.new(attr.outputs["Color"], sep.inputs["Color"])
    uvn = nodes.new("ShaderNodeUVMap")
    uvn.uv_map = lib.UV_TILE
    uv = uvn.outputs["UV"]

    def bsdf(colour, rough, normal=None, metal=0.0):
        b = nodes.new("ShaderNodeBsdfPrincipled")
        if isinstance(colour, tuple):
            b.inputs["Base Color"].default_value = (*colour, 1)
        else:
            nt.links.new(colour, b.inputs["Base Color"])
        if isinstance(rough, float):
            b.inputs["Roughness"].default_value = rough
        else:
            nt.links.new(rough, b.inputs["Roughness"])
        if normal is not None:
            nt.links.new(normal, b.inputs["Normal"])
        b.inputs["Metallic"].default_value = metal
        return b

    if clay:
        wood = bsdf((0.45, 0.42, 0.4), 0.7)
        brass = bsdf((0.75, 0.6, 0.35), 0.5)
        baize = bsdf((0.2, 0.3, 0.25), 0.9)
    else:
        c, r, n = _textured(nt, tex_dir, "walnut", uv)
        wood = bsdf(c, r, n)
        c, r, n = _textured(nt, tex_dir, "brass", uv)
        tint = nodes.new("ShaderNodeMix")
        tint.data_type = "RGBA"
        tint.blend_type = "MULTIPLY"
        tint.inputs["Factor"].default_value = 0.7
        nt.links.new(c, tint.inputs["A"])
        tint.inputs["B"].default_value = (0.82, 0.66, 0.44, 1)
        brass = bsdf(tint.outputs["Result"], 0.42, n, metal=1.0)
        c, r, n = _textured(nt, tex_dir, "baize", uv)
        baize = bsdf(c, 0.95, n)
    is_brass = nodes.new("ShaderNodeMath")
    is_brass.operation = "GREATER_THAN"
    is_brass.inputs[1].default_value = 0.25
    nt.links.new(sep.outputs["Red"], is_brass.inputs[0])
    is_baize = nodes.new("ShaderNodeMath")
    is_baize.operation = "GREATER_THAN"
    is_baize.inputs[1].default_value = 0.75
    nt.links.new(sep.outputs["Red"], is_baize.inputs[0])
    m1 = nodes.new("ShaderNodeMixShader")
    nt.links.new(is_brass.outputs[0], m1.inputs["Fac"])
    nt.links.new(wood.outputs[0], m1.inputs[1])
    nt.links.new(brass.outputs[0], m1.inputs[2])
    m2 = nodes.new("ShaderNodeMixShader")
    nt.links.new(is_baize.outputs[0], m2.inputs["Fac"])
    nt.links.new(m1.outputs[0], m2.inputs[1])
    nt.links.new(baize.outputs[0], m2.inputs[2])
    nt.links.new(m2.outputs[0], out.inputs["Surface"])
    return mat


def stone_material(tex_dir: str, name: str, clay: bool) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    if clay:
        b.inputs["Base Color"].default_value = (0.7, 0.7, 0.7, 1) if "light" in name else (0.15, 0.15, 0.15, 1)
        b.inputs["Roughness"].default_value = 0.6
        return mat
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = lib.UV_TILE
    c, r, n = _textured(nt, tex_dir, name, uvn.outputs["UV"])
    nt.links.new(c, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.12
    nt.links.new(n, b.inputs["Normal"])
    return mat


def inlay_material(clay: bool) -> bpy.types.Material:
    mat = bpy.data.materials.new("inlay")
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes["Principled BSDF"]
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = lib.COLOR
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(attr.outputs["Color"], sep.inputs["Color"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    ramp.color_ramp.elements[0].color = (0.8, 0.62, 0.36, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.02, 0.015, 0.012, 1)
    e = ramp.color_ramp.elements.new(0.25)
    e.color = (0.5, 0.9, 0.7, 1)
    nt.links.new(sep.outputs["Red"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Metallic"].default_value = 0.0 if clay else 0.9
    b.inputs["Roughness"].default_value = 0.4
    return mat


def look(scene, at: Vector, frm: Vector, lens: float) -> None:
    """A camera at game point `frm` looking at game point `at`."""
    data = bpy.data.cameras.new("cam")
    data.lens = lens
    cam = bpy.data.objects.new("cam", data)
    cam.location = gb(*frm)
    direction = gb(*at) - gb(*frm)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam


def lamp(scene, kind: str, energy: float, at: Vector, colour, **settings) -> bpy.types.Object:
    data = bpy.data.lights.new(kind.lower(), kind)
    data.energy = energy
    data.color = colour
    for k, v in settings.items():
        setattr(data, k, v)
    obj = bpy.data.objects.new(data.name, data)
    obj.location = gb(*at)
    scene.collection.objects.link(obj)
    return obj


def preview(objects: dict[str, bpy.types.Object], path: str, tex_dir: str, clay: bool, samples: int) -> None:
    scene = bpy.context.scene
    case = case_material(tex_dir, clay)
    for name, obj in objects.items():
        obj.data.materials.clear()
        if "tiles" in name:
            obj.data.materials.append(stone_material(tex_dir, "marble_light" if "light" in name else "marble_dark", clay))
        elif "inlay" in name:
            obj.data.materials.append(inlay_material(clay))
        else:
            obj.data.materials.append(case)
    # The altar, and the light of the chapel: candles low at the corners, cold light from above.
    altar_mat = bpy.data.materials.new("altar")
    altar_mat.use_nodes = True
    altar_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.27, 0.22, 1)
    altar = bpy.data.objects.new("altar", box(13.0, 2.0, 13.0, y=BOTTOM - 2.0))
    altar.data.materials.append(altar_mat)
    scene.collection.objects.link(altar)
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.02, 0.02, 0.025, 1)
    for sx in (-1, 1):
        for sz in (-1, 1):
            lamp(scene, "POINT", 60, V((sx * 5.6, 0.5, sz * 5.6)), (1.0, 0.7, 0.45), shadow_soft_size=0.1)
    lamp(scene, "AREA", 900, V((0, 14, 0)), (0.85, 0.9, 1.0), size=6)
    lamp(scene, "AREA", 300, V((-6, 4, -14)), (0.7, 0.8, 1.0), size=8)

    lid = bpy.data.objects.new("lid_pivot", None)
    lid.location = gb(0, RIM_TOP, 0)
    scene.collection.objects.link(lid)
    for name, obj in objects.items():
        if name.startswith("lid") or name.startswith("drawer_lid"):
            obj.parent = lid
            obj.matrix_parent_inverse = Matrix.Translation(-gb(0, RIM_TOP, 0))

    scene.render.resolution_x = 1600
    scene.render.resolution_y = 900
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.image_settings.file_format = "PNG"
    shots = {
        "quarter": (V((0.6, -0.45, -4.0)), V((-5.5, 1.6, -13.5)), 38, False, True),
        "side": (V((4.8, -0.4, -0.6)), V((12.5, 0.4, -4.4)), 34, False, True),
        "shut": (V((0.0, 0.0, -0.4)), V((3.0, 13.0, -9.0)), 40, True, False),
        "board": (V((0.0, -0.2, 0.0)), V((0.0, 9.0, -9.5)), 40, False, False),
        "hinge": (V((4.3, 0.06, 0.0)), V((5.7, 1.2, -1.5)), 70, False, False),
        "corner": (V((4.5, -0.35, -4.5)), V((7.2, 1.0, -7.6)), 55, False, True),
    }
    base = os.path.splitext(path)[0]
    for label, (at, frm, lens, shut, open_drawers) in shots.items():
        lid.rotation_euler.x = math.pi if shut else 0.0
        for name, obj in objects.items():
            if name.startswith("drawer"):
                obj.location.x = (TRAVEL if open_drawers else 0.0) * (1 if name.endswith("_e") else -1)
        look(scene, at, frm, lens)
        scene.render.filepath = f"{base}_{label}.png"
        bpy.ops.render.render(write_still=True)
        print(f"preview written to {scene.render.filepath}", flush=True)


# ---------------------------------------------------------------------------

def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--samples", type=int, default=96)
    ap.add_argument("--size", type=int, default=2048)
    ap.add_argument("--no-bake", action="store_true")
    ap.add_argument("--preview", default=None)
    ap.add_argument("--clay", action="store_true")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)

    lib.reset_scene()
    lib.setup_cycles(a.samples)

    void_frame = build_half(False)
    lid_frame = build_half(True)
    tiles = build_tiles()
    inlays = [build_inlay(False), build_inlay(True)]
    drawers = {
        "drawer_void_w": build_drawer("drawer_void_w", -1.0, -1.0),
        "drawer_void_e": build_drawer("drawer_void_e", 1.0, -1.0),
        "drawer_lid_w": build_drawer("drawer_lid_w", -1.0, 1.0),
        "drawer_lid_e": build_drawer("drawer_lid_e", 1.0, 1.0),
    }
    clasp = build_clasp()
    void_frame["meta"] = json.dumps({
        "half": HALF, "rimTop": RIM_TOP, "bottom": BOTTOM, "field": FIELD, "face": FACE,
        "hinge": {"y": RIM_TOP, "z": 0.0},
        "drawer": {"travel": TRAVEL, "floor": DRAWER_FLOOR, "wall": DRAWER_WALL,
                   # The baize inside a drawer when it is out: across x from the case's face, along z
                   # from the hinge line.
                   "inside": [HALF, FACE - 0.08 + TRAVEL, DRAWER_NEAR + 0.08, DRAWER_FAR - 0.08]},
        "clasp": {"pivot": list(CLASP_PIVOT), "shut": math.pi},
    })

    everything = {o.name: o for o in (void_frame, lid_frame, *tiles, *inlays, *drawers.values(), clasp)}
    for obj in everything.values():
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"{obj.name}: {len(obj.data.vertices)} vertices, {tris} triangles", flush=True)

    baked = [void_frame, lid_frame, *drawers.values(), clasp]
    for obj in baked:
        unwrap(obj, CELLS[obj.name])
    if not a.no_bake:
        bake(baked, drawers, out, a.size)
        lib.export_glb(list(everything.values()), os.path.join(out, "board.glb"))
    if a.preview:
        preview(everything, os.path.abspath(a.preview), os.path.join(out, "tex"), a.clay, min(a.samples, 64))


if __name__ == "__main__":
    main()
