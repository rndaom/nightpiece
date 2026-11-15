"""Build the chapel the board is played in, and bake the light that never changes.

    blender -b --factory-startup -P assets/src/environment.py -- --out public/assets [--samples 192] [--size 2048] [--no-bake]
    blender -b --factory-startup -P assets/src/environment.py -- --preview tmp/room/clay

Writes <out>/room.glb, <out>/tex/room_ao.jpg and <out>/tex/room_light.jpg. The board is not built
here: the case is (assets/src/case.py, board.glb). While the light is baked a plain dark box
stands where the case will, so that the altar's top is shaded as the case shades it. `--preview`
builds the room without baking it and renders clay pictures of it from where the game's cameras
stand, into the folder given.

The room is the crossing of a small Gothic Revival church in warm sandstone. Every wall is an
arcade of pointed arches on piers of clustered shafts: in each of the six outer bays a pointed
niche of candles low down, a string course, and a tall window of two lights under a quatrefoil;
a roundel high up under the vault. The two middle bays of every wall are one great arch: on
Void's wall (-z) a rose whose ring of glass is Void's light, on Ivory's (+z) a full rose glowing
gold, each over a trough of its own light at the foot of the wall; on the other two an open
doorway with a cross of lancets over it, the night showing through both. A shallow ribbed vault
gathers on a square collar round the opening over the board. Iron lanterns hang in front of the
piers.

room.glb
    plinth      the altar: a stone table on a footpace of two steps, its body a blind arcade of
                pointed panels between colonnettes at the corners, its top (the mensa) at y = -1
                with a moulded edge. (Named `plinth` for the engine, which has always called it that.)
    floor       the floor. Its flags are drawn by the engine, so that the baked light on it is
                all one piece.
    shell       the walls, the vault and the collar round the opening.
    timber      the oak doors, standing open.
    metal       the lanterns, their rods and brackets, the doors' ironwork, and the brass
                candlesticks on the altar. Red = 1 marks brass; green is how much of its own
                lantern's light falls on a part.
    candles     tallow candles; flame positions are in the object's metadata. Red = 1 marks a wick;
                green is how far up its candle a point is.
    glow        everything that is itself light. Red = kind / 8: 0 the line of light under the
                mensa, 1 night sky (the windows and the doorways), 2 Void's rose and the trough
                under it, 3 Ivory's rose and the trough under it, 4 lantern glass. Green, on
                lantern glass, is how near the flame inside a point is.

The two atlases are sampled with the second UV set and hold one kind of light per channel, so
the engine can colour and dim each on its own:
    room_ao.jpg      R ambient occlusion (linear). G Void's rose's light, or on the altar the light
                     of the line under its mensa. B Ivory's rose's light.
    room_light.jpg   R candles in the niches and the lanterns. G night sky through the windows,
                     the doorways and the opening over the board. B the key's light after its
                     first bounce.
    Everything but the occlusion is stored as value ^ (1 / 2.2).

Everything is in game space: one unit is one square, the playing surface is y = 0,
Ivory sits at +z. See docs/style-bible.md, sections 4, 5 and 9.
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
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib  # noqa: E402
from lib import box, cylinder, finish_stone, gb, prism  # noqa: E402

V = Vector
HERE = os.path.dirname(os.path.abspath(__file__))
TAU = math.tau

# The room. What the cameras need: nothing but the altar and what stands on it comes nearer the
# middle than REACH below CLEAR_Y.
FLOOR_Y = -3.0
WALL = 23.0
THICK = 2.6
CEILING = 25.0              # the vault's underside where it meets the collar round the opening
BAY = 5.75
OCULUS = 3.3                # half the width of the opening over the board
COLLAR_FOOT = CEILING - 1.4  # the foot of the collar, which is what cuts the key's light to a square
COLLAR_OUT = 4.6            # how far out the collar reaches; the vault's ribs die into it
SHAFT_TOP = 26.7            # the top of the short square shaft the opening rises through
KEY_HEIGHT = 78.0           # the engine's key light hangs here: so far above the opening that what comes through falls on the altar and no wider
REACH = 20.7
CLEAR_Y = 22.6

# The walls, in a frame of their own: u along the wall, d into it (0 on the wall's face, less
# than 0 out into the room). Each bay is an arch standing in front of a wall set back RECESS.
RECESS = 0.6
PIER_HALF = 0.8             # half the width of the wall left between two bays
SHAFT_R = 0.42              # the shaft up the front of each pier, that the vault springs from
SHAFT_D = -0.3
NOOK_R = 0.2                # the shafts in the corners of each bay, that carry its arch
FOOT_TOP = -0.7             # the top of the tall plinths the piers stand on
ARCADE_NECK = 12.85         # the necking of the nook shafts' capitals: their abaci come to ARCADE_SPRING
ARCADE_SPRING = 13.4        # where the arches of the bays spring
VAULT_NECK = 20.6
VAULT_SPRING = 21.5         # where the vault leaves the wall
BAY_HALF = BAY / 2 - PIER_HALF
GREAT_HALF = BAY - PIER_HALF
GREAT_RADIUS = 7.0          # the great arch of the middle bays is a little dropped, to stay under the vault
SPLIT_Y = 10.0              # walls below this are seen directly, and get most of the atlas
SKIRT = -2.4                # the top of the plinth course along the foot of every wall

# A candle niche: its opening, how far back it goes from the wall's face, the height of its floor.
NICHE_WIDTH = 2.6
NICHE_SPRING = 1.4
NICHE_FLOOR = -1.1
NICHE_BACK = RECESS + 1.5
NICHE_RADIUS = NICHE_WIDTH  # equilateral

STRING_Y = 5.0              # the string course the windows stand on

# The windows of the outer bays, and the roundels over them.
WINDOW_HALF = 1.45
WINDOW_SILL = 5.6
WINDOW_SPRING = 12.4
ROUNDEL_Y = 19.2
ROUNDEL_R = 0.85

# The two roses, and the cross of lancets over each doorway.
RELIEF_Y = 5.6
RING_OUTER = 5.0
RING_INNER = 3.5
DISC_RADIUS = 4.6
TROUGH = 4.3                # half the length of the trough of light under each rose
CROSS_HALF = 0.75
CROSS_FOOT = 5.4
CROSS_SPRING = 17.4
ARM_AT = 2.0                # how far either side of the upright the two lights of the arm stand
ARM_HALF = 0.55
ARM_SILL = 11.2
ARM_SPRING = 13.0
DOOR_HALF = 1.35
DOOR_SPRING = 1.0

# The vault: its height at a reach r out from the middle is VAULT_SPRING + VAULT_RISE * vault_t(r).
VAULT_RISE = CEILING - VAULT_SPRING
LIERNES = (12.5, 8.0)

# The altar.
ALTAR_TOP = -1.0
MENSA = 6.6
BODY = 6.35
STEP_1 = (7.6, -2.8)
STEP_2 = (7.15, -2.6)
BODY_FOOT = -2.6
BODY_TOP = -1.36
CASE = 4.8                  # the case that stands on it, for the bake: half its width, and its top
CASE_TOP = 0.1

# Lanterns: in front of every pier, the middle of the glass this far out from the wall and this high.
LANTERN_D = -1.7
LANTERN_Y = 3.2
LANTERN_R = 0.37            # from the axis to a corner of the glass
LANTERN_HANG = 12.35        # where the rod meets its bracket

GLOW_SLOT, GLOW_SKY, GLOW_RING, GLOW_DISC, GLOW_LANTERN = 0, 1, 2, 3, 4
SLOT_GLOW = 10.0            # how bright the line under the mensa is when its light is baked

PIERS = (-17.25, -11.5, -5.75, 5.75, 11.5, 17.25)
OUTER_BAYS = (-20.125, -14.375, -8.625, 8.625, 14.375, 20.125)


# ---------------------------------------------------------------------------
# Meshes from points
# ---------------------------------------------------------------------------

def solid(points: list[Vector], faces: list[tuple[int, ...]], name: str = "solid") -> bpy.types.Mesh:
    """A closed mesh from game-space points and faces given as indices into them."""
    bm = bmesh.new()
    verts = [bm.verts.new(gb(p.x, p.y, p.z)) for p in points]
    for f in faces:
        try:
            bm.faces.new([verts[i] for i in f])
        except ValueError:
            pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def sheet(points: list[Vector], faces: list[tuple[int, ...]], name: str = "sheet") -> bpy.types.Mesh:
    """An open surface, its faces wound as given (counter-clockwise seen from the side they face)."""
    bm = bmesh.new()
    verts = [bm.verts.new(gb(p.x, p.y, p.z)) for p in points]
    for f in faces:
        bm.faces.new([verts[i] for i in f])
    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def rings(loops: list[list[Vector]], closed_loop: bool, cap: bool, name: str) -> bpy.types.Mesh:
    """A solid through a run of loops of points, each as long as the others: faces join each loop
    to the next, and (with `cap`) the first and last loops are closed over."""
    points = [p for loop in loops for p in loop]
    n = len(loops[0])
    faces = []
    for i in range(len(loops) - 1):
        a, b = i * n, (i + 1) * n
        for k in range(n if closed_loop else n - 1):
            k1 = (k + 1) % n
            faces.append((a + k, a + k1, b + k1, b + k))
    if cap:
        faces.append(tuple(range(n)))
        faces.append(tuple(range((len(loops) - 1) * n, len(loops) * n))[::-1])
    return solid(points, faces, name)


def lathe(profile: list[tuple[float, float]], x: float, z: float, segments: int, turn: float = 0.0) -> bpy.types.Mesh:
    """A solid of revolution about the upright through (x, z). The profile is (radius, height)
    from the axis at the bottom to the axis at the top."""
    points: list[Vector] = []
    starts: list[tuple[bool, int]] = []
    for r, y in profile:
        if r < 1e-6:
            starts.append((True, len(points)))
            points.append(V((x, y, z)))
        else:
            starts.append((False, len(points)))
            for k in range(segments):
                a = turn + k * TAU / segments
                points.append(V((x + r * math.cos(a), y, z + r * math.sin(a))))
    faces = []
    for (pole_a, a), (pole_b, b) in zip(starts, starts[1:]):
        for k in range(segments):
            k1 = (k + 1) % segments
            if pole_a and not pole_b:
                faces.append((a, b + k1, b + k))
            elif pole_b and not pole_a:
                faces.append((a + k, a + k1, b))
            elif not pole_a and not pole_b:
                faces.append((a + k, a + k1, b + k1, b + k))
    return solid(points, faces, "lathe")


def offset_polygon(poly: list[tuple[float, float]], o: float) -> list[tuple[float, float]]:
    """A convex polygon (counter-clockwise, in x and z) grown outward by `o`, its corners mitred."""
    out = []
    n = len(poly)
    for i in range(n):
        p0, p1, p2 = V(poly[i - 1]), V(poly[i]), V(poly[(i + 1) % n])
        e1 = (p1 - p0).normalized()
        e2 = (p2 - p1).normalized()
        n1 = V((e1.y, -e1.x))
        n2 = V((e2.y, -e2.x))
        m = (n1 + n2) * (o / max(1.0 + n1.dot(n2), 1e-6))
        out.append((p1.x + m.x, p1.y + m.y))
    return out


def pstack(plan: list[tuple[float, float]], profile: list[tuple[float, float]]) -> bpy.types.Mesh:
    """A block on a convex plan (x, z, counter-clockwise seen from above), its sides moulded by a
    profile of (how far out from the plan, height), bottom to top."""
    loops = [[V((x, y, z)) for x, z in offset_polygon(plan, o)] for o, y in profile]
    return rings(loops, True, True, "stack")


def square(half: float) -> list[tuple[float, float]]:
    return [(-half, -half), (half, -half), (half, half), (-half, half)]


# ---------------------------------------------------------------------------
# Pointed arches and the wall's own frame
# ---------------------------------------------------------------------------

def arch(half: float, spring: float, radius: float, segments: int = 12, u: float = 0.0) -> list[tuple[float, float]]:
    """The head of a two-centred pointed arch over an opening 2 * half wide, springing at `spring`:
    (u, y) from the left springing over the apex to the right. Each side is struck from a centre
    on the springing line on the far side of the middle; `radius` = 2 * half is equilateral."""
    c = radius - half
    apex = math.acos(-c / radius)
    left = []
    for i in range(segments + 1):
        a = math.pi - (math.pi - apex) * i / segments
        left.append((u + c + radius * math.cos(a), spring + radius * math.sin(a)))
    right = [(2 * u - x, y) for x, y in left[-2::-1]]
    left[-1] = (u, left[-1][1])
    return left + right


def apex_of(half: float, spring: float, radius: float) -> float:
    c = radius - half
    return spring + math.sqrt(radius * radius - c * c)


def opening(half: float, bottom: float, spring: float, radius: float, segments: int = 12, u: float = 0.0) -> list[tuple[float, float]]:
    """A pointed opening: up one jamb from `bottom`, over the arch and down the other."""
    return [(u - half, bottom)] + arch(half, spring, radius, segments, u) + [(u + half, bottom)]


def circle(radius: float, y: float, segments: int, u: float = 0.0) -> list[tuple[float, float]]:
    return [(u + radius * math.cos(k * TAU / segments + math.pi / 2), y + radius * math.sin(k * TAU / segments + math.pi / 2))
            for k in range(segments)]


def W(u: float, y: float, d: float) -> Vector:
    """A point in a wall's own frame, as it is on Void's wall (-z). Every wall is built there and turned into place."""
    return V((u, y, -(WALL + d)))


def local(c: Vector) -> tuple[float, float, float]:
    """The other way: (u, y, d) of a game-space point on Void's wall."""
    return c.x, c.y, -c.z - WALL


def slab(outline: list[tuple[float, float]], d0: float, d1: float) -> bpy.types.Mesh:
    """An outline in the wall's plane, carried from d0 to d1."""
    return rings([[W(u, y, d) for u, y in outline] for d in (d0, d1)], True, True, "slab")


def loft(front: list[tuple[float, float]], back: list[tuple[float, float]], d0: float, d1: float) -> bpy.types.Mesh:
    """A solid from one outline at d0 to another of as many points at d1: a splayed reveal's cutter."""
    return rings([[W(u, y, d0) for u, y in front], [W(u, y, d1) for u, y in back]], True, True, "loft")


def sweep(profile: list[tuple[float, float]], path, closed_path: bool = False) -> bpy.types.Mesh:
    """A moulding: a closed profile of (o, d), o outward from an edge in the wall's plane and d
    into the wall, carried along that edge. `path(o)` is the edge grown outward by o, as (u, y);
    every opening here is struck from fixed centres, so growing it is exact."""
    loops = [[W(u, y, d) for u, y in path(o)] for o, d in profile]
    # Turn it so that each ring of the solid is one point along the edge.
    n = len(loops[0])
    across = [[loops[j][i] for j in range(len(loops))] for i in range(n)]
    if closed_path:
        across.append(across[0])
        return rings(across, True, False, "moulding")
    return rings(across, True, True, "moulding")


def roll(r: float, back: float = 0.06, segments: int = 6, at: tuple[float, float] = (0.0, 0.0)) -> list[tuple[float, float]]:
    """The profile of a roll moulding of radius r on an arris, closed through the wall behind it."""
    o0, d0 = at
    pts = [(o0 + r * math.cos(a), d0 - r * math.sin(a))
           for a in (-math.pi * 0.25 + k * math.pi * 1.5 / segments for k in range(segments + 1))]
    return pts + [(o0 + back * 0.5, d0 + r + back), (o0 + r + back, d0 + back)]


def turn_to(mesh: bpy.types.Mesh, wall: str) -> bpy.types.Mesh:
    """Turn a mesh built on Void's wall to stand on another."""
    angle = {"n": 0.0, "e": -math.pi / 2, "s": math.pi, "w": math.pi / 2}[wall]
    if angle:
        mesh.transform(Matrix.Rotation(angle, 4, "Z"))
    return mesh


def turn_point(p: Vector, wall: str) -> Vector:
    b = Matrix.Rotation({"n": 0.0, "e": -math.pi / 2, "s": math.pi, "w": math.pi / 2}[wall], 3, "Z") @ gb(p.x, p.y, p.z)
    return V((b.x, b.z, -b.y))


def strip(mesh: bpy.types.Mesh, hidden) -> bpy.types.Mesh:
    """Delete the faces for which `hidden(centre, normal)` (both in game space) is true: the ones
    nobody inside the room can see, which would only waste room in the baked atlases."""
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


def split(mesh: bpy.types.Mesh, y: float) -> tuple[bpy.types.Mesh, bpy.types.Mesh]:
    """Cut a mesh at a height. Returns what is below and what is above; consumes the mesh."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=gb(0.0, y, 0.0),
                           plane_no=(0.0, 0.0, 1.0), dist=1e-5)
    parts = []
    for above in (False, True):
        part = bm.copy()
        doomed = [f for f in part.faces if (f.calc_center_median().z > y) != above]
        bmesh.ops.delete(part, geom=doomed, context="FACES")
        out = bpy.data.meshes.new("above" if above else "below")
        part.to_mesh(out)
        part.free()
        parts.append(out)
    bm.free()
    bpy.data.meshes.remove(mesh)
    return parts[0], parts[1]


def unwrap(obj: bpy.types.Object, cell: tuple[float, float, float, float], margin: float = 0.004, angle: float = 60.0) -> None:
    """Fill the second UV set with an unwrap that overlaps nowhere, in the square `cell`
    (u0, v0, u1, v1) of an atlas. Packs a little tighter than lib.unwrap_unique."""
    mesh = obj.data
    mesh.uv_layers.active = mesh.uv_layers[lib.UV_UNIQUE]
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, rotate_method="CARDINAL", shape_method="CONCAVE", margin_method="FRACTION", margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    u0, v0, u1, v1 = cell
    pad = 0.004
    for d in mesh.uv_layers[lib.UV_UNIQUE].data:      # fetched afresh: leaving edit mode moves the mesh's arrays
        d.uv = (u0 + (pad + d.uv[0] * (1 - 2 * pad)) * (u1 - u0), v0 + (pad + d.uv[1] * (1 - 2 * pad)) * (v1 - v0))
    mesh.uv_layers.active = mesh.uv_layers[lib.UV_TILE]


def stone(mesh: bpy.types.Mesh, bevel: float = 0.0, scale: float = 1 / 7.0, offset=(0.17, 0.31), red: float | None = None) -> bpy.types.Mesh:
    return finish_stone(mesh, 0, bevel=bevel, uv_scale=scale, uv_offset=offset, red=red)


# ---------------------------------------------------------------------------
# Shafts, bases and capitals
# ---------------------------------------------------------------------------

def shaft_profile(r: float, foot: float, neck: float, capital: bool = True, rings_at: tuple[float, ...] = ()) -> list[tuple[float, float]]:
    """A round shaft from its base to its capital: a base of two rolls with a hollow between, a
    plain shaft (with a ring round it at each height in `rings_at`), a necking ring, a bell that
    flares out, and a moulded abacus."""
    k = r / SHAFT_R * 0.75 + 0.25        # the small shafts' mouldings are a little finer
    p = [(0.0, foot), (r + 0.25 * k, foot), (r + 0.26 * k, foot + 0.12 * k), (r + 0.12 * k, foot + 0.2 * k),
         (r + 0.07 * k, foot + 0.25 * k), (r + 0.11 * k, foot + 0.33 * k), (r, foot + 0.4 * k)]
    for y in rings_at:
        p += [(r, y - 0.09), (r + 0.07, y - 0.04), (r + 0.07, y + 0.04), (r, y + 0.09)]
    p += [(r, neck), (r + 0.06 * k, neck + 0.05 * k), (r + 0.02 * k, neck + 0.11 * k)]
    if capital:
        p += [(r + 0.06 * k, neck + 0.42 * k), (r + 0.2 * k, neck + 0.62 * k), (r + 0.31 * k, neck + 0.68 * k),
              (r + 0.31 * k, neck + 0.78 * k), (r + 0.26 * k, neck + 0.84 * k), (r + 0.27 * k, neck + 0.9 * k), (0.0, neck + 0.9 * k)]
    else:
        p += [(0.0, neck + 0.11 * k)]
    return p


# The tall plinth under every pier: a foot, a plain face, and a weathered cap. (Out from the plan, height.)
PLINTH = [(0.08, FLOOR_Y), (0.08, FLOOR_Y + 0.22), (0.0, FLOOR_Y + 0.3), (0.0, FOOT_TOP - 0.24),
          (0.07, FOOT_TOP - 0.19), (0.07, FOOT_TOP - 0.1), (0.0, FOOT_TOP - 0.04), (-0.02, FOOT_TOP)]


def pier(u: float) -> list[bpy.types.Mesh]:
    """A pier on Void's wall at `u`: a tall plinth, the shaft up its front that the vault springs
    from, and a shaft in the corner of the bay on either side that carries that bay's arch."""
    parts = []
    # In game x and z on Void's wall, where the room is toward +z: back into the wall, out to a
    # front with its corners cut.
    plan = [(u - 1.12, -(WALL + 0.7)), (u + 1.12, -(WALL + 0.7)), (u + 1.12, -(WALL - 0.55)), (u + 0.76, -(WALL - 1.08)),
            (u - 0.76, -(WALL - 1.08)), (u - 1.12, -(WALL - 0.55))]
    parts.append(stone(pstack(plan, PLINTH), scale=1 / 3.0))
    main = W(u, 0.0, SHAFT_D)
    parts.append(lathe(shaft_profile(SHAFT_R, FOOT_TOP, VAULT_NECK, rings_at=(ARCADE_NECK + 0.3,)), main.x, main.z, 12))
    for side in (-1, 1):
        nook = W(u + side * PIER_HALF, 0.0, 0.0)
        parts.append(lathe(shaft_profile(NOOK_R, FOOT_TOP, ARCADE_NECK), nook.x, nook.z, 12))
    return parts


def corner_pier() -> list[bpy.types.Mesh]:
    """The pier in the corner Void's wall shares with the wall at +x: a plinth across the corner,
    a shaft on the diagonal, from which the diagonal rib of the vault springs, and the shafts in
    the corners of the last bay of each of the two walls."""
    c = WALL - 0.32
    plan = [(WALL - 1.25, -(WALL + 0.5)), (WALL + 0.5, -(WALL + 0.5)), (WALL + 0.5, -(WALL - 1.25)), (WALL - 0.65, -(WALL - 1.25)),
            (WALL - 1.25, -(WALL - 0.65))]
    return [stone(pstack(plan, PLINTH), scale=1 / 3.0),
            lathe(shaft_profile(SHAFT_R, FOOT_TOP, VAULT_NECK, rings_at=(ARCADE_NECK + 0.3,)), c, -c, 12),
            lathe(shaft_profile(NOOK_R, FOOT_TOP, ARCADE_NECK), WALL - PIER_HALF, -WALL, 12),
            lathe(shaft_profile(NOOK_R, FOOT_TOP, ARCADE_NECK), WALL, -(WALL - PIER_HALF), 12)]


# ---------------------------------------------------------------------------
# The walls
# ---------------------------------------------------------------------------

ARCH_ORDER = roll(0.13, at=(0.0, -0.02)) + []          # the roll on the arris of every bay's arch
ARCH_BAND = [(0.13, 0.04), (0.13, -0.05), (0.2, -0.1), (0.48, -0.1), (0.48, 0.04)]
HOOD = [(0.0, 0.03), (0.0, -0.06), (0.06, -0.13), (0.16, -0.13), (0.22, -0.06), (0.22, 0.03)]
STRING = [(0.04, STRING_Y - 0.02), (-0.18, STRING_Y + 0.02), (-0.24, STRING_Y + 0.12), (-0.24, STRING_Y + 0.26),
          (-0.12, STRING_Y + 0.4), (0.04, STRING_Y + 0.42)]       # (d, y)


def rail(profile: list[tuple[float, float]], u0: float, u1: float) -> bpy.types.Mesh:
    """A horizontal moulding along a wall from u0 to u1, its section given as (d, y)."""
    return rings([[W(u, y, d) for d, y in profile] for u in (u0, u1)], True, True, "rail")


def bay_cutters(u: float) -> list[bpy.types.Mesh]:
    """What is cut out of the wall for an outer bay centred at `u`: the bay itself, set back behind
    its arch; the candle niche in two orders; the window through the wall above, splayed; and
    the roundel high up."""
    cuts = [slab(opening(BAY_HALF, FLOOR_Y - 0.5, ARCADE_SPRING, 2 * BAY_HALF, u=u), -0.5, RECESS)]
    r = NICHE_RADIUS
    h = NICHE_WIDTH / 2
    cuts.append(slab(opening(h + 0.22, NICHE_FLOOR, NICHE_SPRING, r + 0.22, u=u), RECESS - 0.1, RECESS + 0.24))
    cuts.append(slab(opening(h, NICHE_FLOOR, NICHE_SPRING, r, u=u), RECESS - 0.1, NICHE_BACK))
    wr = 2 * WINDOW_HALF
    cuts.append(loft(opening(WINDOW_HALF + 0.38, WINDOW_SILL - 0.4, WINDOW_SPRING, wr + 0.38, u=u),
                     opening(WINDOW_HALF, WINDOW_SILL, WINDOW_SPRING, wr, u=u), RECESS - 0.05, RECESS + 0.75))
    cuts.append(slab(opening(WINDOW_HALF, WINDOW_SILL, WINDOW_SPRING, wr, u=u), RECESS + 0.7, THICK + 0.3))
    cuts.append(loft(circle(ROUNDEL_R + 0.3, ROUNDEL_Y, 20, u), circle(ROUNDEL_R, ROUNDEL_Y, 20, u), -0.05, 0.45))
    cuts.append(slab(circle(ROUNDEL_R, ROUNDEL_Y, 20, u), 0.4, THICK + 0.3))
    return cuts


def bay_details(u: float) -> list[bpy.types.Mesh]:
    """The mouldings and tracery of an outer bay at `u`."""
    parts = []
    # The arch: a roll on its arris and a broad band round it, from capital to capital.
    br = 2 * BAY_HALF
    for prof in (ARCH_ORDER, ARCH_BAND):
        parts.append(sweep(prof, lambda o: arch(BAY_HALF + o, ARCADE_SPRING, br + o, 8, u)))
    # The niche: a roll round its outer order and a sill under it.
    h = NICHE_WIDTH / 2 + 0.22
    r = NICHE_RADIUS + 0.22
    parts.append(sweep(roll(0.08, at=(0.0, RECESS - 0.01)), lambda o: opening(h + o, NICHE_FLOOR, NICHE_SPRING, r + o, 8, u)))
    parts.append(rail([(RECESS + 0.05, NICHE_FLOOR - 0.22), (RECESS - 0.12, NICHE_FLOOR - 0.16), (RECESS - 0.2, NICHE_FLOOR - 0.04),
                       (RECESS - 0.2, NICHE_FLOOR), (RECESS + 0.05, NICHE_FLOOR)], u - h - 0.12, u + h + 0.12))
    # The string course the window stands on, from shaft to shaft.
    parts.append(rail([(d + RECESS, y) for d, y in STRING], u - BAY_HALF + 0.05, u + BAY_HALF - 0.05))
    # The window: a roll round its splay and a plate of tracery in it.
    wr = 2 * WINDOW_HALF
    parts.append(sweep(roll(0.09, at=(0.0, RECESS - 0.03)),
                       lambda o: opening(WINDOW_HALF + 0.38 + o, WINDOW_SILL - 0.4, WINDOW_SPRING, wr + 0.38 + o, 8, u)))
    parts.append(tracery(u))
    parts.append(sweep(roll(0.08, at=(0.0, -0.02)), lambda o: circle(ROUNDEL_R + 0.3 + o, ROUNDEL_Y, 20, u), True))
    parts.append(roundel(u))
    # The plinth course along the foot of the wall, in the bay.
    parts.append(rail([(RECESS + 0.05, FLOOR_Y), (RECESS - 0.36, FLOOR_Y), (RECESS - 0.36, SKIRT - 0.12),
                       (RECESS - 0.26, SKIRT), (RECESS + 0.05, SKIRT)], u - BAY_HALF, u + BAY_HALF))
    return parts


def tracery(u: float) -> bpy.types.Mesh:
    """Plate tracery in a window: two lancets under a quatrefoil."""
    wr = 2 * WINDOW_HALF
    plate = slab(opening(WINDOW_HALF + 0.02, WINDOW_SILL - 0.02, WINDOW_SPRING, wr + 0.02, u=u), RECESS + 0.78, RECESS + 1.0)
    cuts = []
    light = 0.56
    for side in (-1, 1):
        cuts.append(slab(opening(light, WINDOW_SILL + 0.16, WINDOW_SPRING - 0.7, 2 * light, 10, u + side * 0.66), RECESS + 0.7, RECESS + 1.1))
    for du, dy in ((0.3, 0.0), (-0.3, 0.0), (0.0, 0.3), (0.0, -0.3), (0.0, 0.0)):
        cuts.append(slab(circle(0.3, WINDOW_SPRING + 1.15 + dy, 12, u + du), RECESS + 0.7, RECESS + 1.1))
    return lib.subtract(plate, cuts)


def roundel(u: float) -> bpy.types.Mesh:
    """A quatrefoil pierced through a roundel's plate."""
    plate = slab(circle(ROUNDEL_R + 0.02, ROUNDEL_Y, 20, u), 0.5, 0.7)
    cuts = [slab(circle(0.3, ROUNDEL_Y + dy, 12, u + du), 0.4, 0.8) for du, dy in ((0.33, 0), (-0.33, 0), (0, 0.33), (0, -0.33))]
    cuts.append(slab(circle(0.3, ROUNDEL_Y, 12, u), 0.4, 0.8))
    return lib.subtract(plate, cuts)


def great_cutters(wall: str) -> list[bpy.types.Mesh]:
    """What is cut out of the two middle bays of a wall: the great arch, and what stands in it."""
    cuts = [slab(opening(GREAT_HALF, FLOOR_Y - 0.5, ARCADE_SPRING, GREAT_RADIUS), -0.5, RECESS)]
    if wall in "ns":
        radius = RING_OUTER if wall == "n" else DISC_RADIUS
        cuts.append(loft(circle(radius + 0.5, RELIEF_Y, 48), circle(radius, RELIEF_Y, 48), RECESS - 0.05, RECESS + 0.45))
        cuts.append(slab(circle(radius, RELIEF_Y, 48), RECESS + 0.4, THICK + 0.3))
        # A blind arcade under the rose, and a trough of light in the kerb at its foot.
        for i in range(6):
            cu = (i - 2.5) * 1.62
            cuts.append(slab(opening(0.56, SKIRT + 0.32, -0.95, 1.12, 10, cu), RECESS - 0.1, RECESS + 0.1))
        # Three blind lancets over the rose.
        for cu, half, sill, spring in ((0.0, 0.62, 12.0, 17.2), (-1.75, 0.5, 12.0, 15.6), (1.75, 0.5, 12.0, 15.6)):
            cuts.append(slab(opening(half, sill, spring, 2 * half, 10, cu), RECESS - 0.1, RECESS + 0.16))
    else:
        # The doorway, in three orders, and the cross of lancets over it, each splayed.
        for grow, d0, d1 in ((0.6, RECESS - 0.1, RECESS + 0.2), (0.3, RECESS + 0.18, RECESS + 0.4), (0.0, RECESS + 0.38, THICK + 0.6)):
            cuts.append(slab(opening(DOOR_HALF + grow, FLOOR_Y - 0.5, DOOR_SPRING, 2 * DOOR_HALF + grow), d0, d1))
        for cu, half, sill, spring in ((0.0, CROSS_HALF, CROSS_FOOT, CROSS_SPRING), (-ARM_AT, ARM_HALF, ARM_SILL, ARM_SPRING),
                                       (ARM_AT, ARM_HALF, ARM_SILL, ARM_SPRING)):
            cuts.append(loft(opening(half + 0.3, sill - 0.3, spring, 2 * half + 0.3, 12, cu), opening(half, sill, spring, 2 * half, 12, cu),
                             RECESS - 0.05, RECESS + 0.6))
            cuts.append(slab(opening(half, sill, spring, 2 * half, 12, cu), RECESS + 0.55, THICK + 0.3))
    return cuts


def great_details(wall: str) -> list[bpy.types.Mesh]:
    parts = []
    for prof in (ARCH_ORDER, ARCH_BAND):
        parts.append(sweep(prof, lambda o: arch(GREAT_HALF + o, ARCADE_SPRING, GREAT_RADIUS + o, 16)))
    parts.append(rail([(RECESS + 0.05, FLOOR_Y), (RECESS - 0.36, FLOOR_Y), (RECESS - 0.36, SKIRT - 0.12),
                       (RECESS - 0.26, SKIRT), (RECESS + 0.05, SKIRT)], -GREAT_HALF, GREAT_HALF))
    if wall in "ns":
        radius = RING_OUTER if wall == "n" else DISC_RADIUS
        # Rolls round the rose's splay and a hood round all.
        parts.append(sweep(roll(0.12, at=(0.0, RECESS - 0.03)), lambda o: circle(radius + 0.5 + o, RELIEF_Y, 48), True))
        parts.append(sweep([(o + 0.72, d + RECESS) for o, d in HOOD], lambda o: circle(radius + o, RELIEF_Y, 48), True))
        parts.extend(rose(wall))
        # The kerb at the foot of the wall, with the trough of light let into its top.
        kerb = slab([(-TROUGH - 0.3, FLOOR_Y), (-TROUGH - 0.3, SKIRT + 0.05), (TROUGH + 0.3, SKIRT + 0.05), (TROUGH + 0.3, FLOOR_Y)],
                    -0.95, RECESS + 0.05)
        kerb = lib.subtract(kerb, [slab([(-TROUGH, SKIRT - 0.32), (-TROUGH, SKIRT + 0.3), (TROUGH, SKIRT + 0.3), (TROUGH, SKIRT - 0.32)],
                                        -0.62, -0.12)])
        parts.append(stone(kerb, bevel=0.03, scale=1 / 3.0))
        for cu, half, sill, spring in ((0.0, 0.62, 12.0, 17.2), (-1.75, 0.5, 12.0, 15.6), (1.75, 0.5, 12.0, 15.6)):
            parts.append(sweep([(o + 0.0, d + RECESS) for o, d in roll(0.07, at=(0.0, -0.01))],
                               lambda o, cu=cu, half=half, sill=sill, spring=spring: opening(half + o, sill, spring, 2 * half + o, 10, cu)))
        parts.append(rail([(RECESS + 0.05, 11.68), (RECESS - 0.2, 11.72), (RECESS - 0.26, 11.84), (RECESS - 0.26, 11.96),
                           (RECESS - 0.14, 12.05), (RECESS + 0.05, 12.06)], -2.6, 2.6))
    else:
        for grow in (0.6, 0.3, 0.0):
            at = {0.6: RECESS - 0.01, 0.3: RECESS + 0.19, 0.0: RECESS + 0.39}[grow]
            parts.append(sweep(roll(0.09, at=(0.0, at)),
                               lambda o, grow=grow: opening(DOOR_HALF + grow + o, FLOOR_Y, DOOR_SPRING, 2 * DOOR_HALF + grow + o, 10)))
        parts.append(sweep([(o + 0.66, d + RECESS) for o, d in HOOD], lambda o: arch(DOOR_HALF + o, DOOR_SPRING, 2 * DOOR_HALF + o, 10)))
        for cu, half, sill, spring in ((0.0, CROSS_HALF, CROSS_FOOT, CROSS_SPRING), (-ARM_AT, ARM_HALF, ARM_SILL, ARM_SPRING),
                                       (ARM_AT, ARM_HALF, ARM_SILL, ARM_SPRING)):
            parts.append(sweep(roll(0.08, at=(0.0, RECESS - 0.03)),
                               lambda o, cu=cu, half=half, sill=sill, spring=spring: opening(half + 0.3 + o, sill - 0.3, spring, 2 * half + 0.3 + o, 8, cu)))
        parts.append(sweep([(o + 0.42, d + RECESS) for o, d in HOOD], lambda o: arch(CROSS_HALF + o, CROSS_SPRING, 2 * CROSS_HALF + o, 8)))
        # A sill course under the cross, from jamb to jamb of the great arch.
        parts.append(rail([(d + RECESS, y - STRING_Y + CROSS_FOOT - 0.75) for d, y in STRING], -GREAT_HALF + 0.05, GREAT_HALF - 0.05))
    return parts


def rose(wall: str) -> list[bpy.types.Mesh]:
    """The tracery of a rose. Void's is a ring of sixteen lights round a solid wheel carved with
    rings; Ivory's is glass all through: an eye, six lights round it and twelve round those."""
    d0, d1 = RECESS + 0.5, RECESS + 0.78
    parts = []

    def annulus(r0: float, r1: float, a: float, b: float, segments: int = 48) -> bpy.types.Mesh:
        loops = [[W(r * math.cos(k * TAU / segments), RELIEF_Y + r * math.sin(k * TAU / segments), d) for k in range(segments)]
                 for r, d in ((r0, a), (r1, a), (r1, b), (r0, b))]
        loops.append(loops[0])
        return rings(loops, True, False, "annulus")

    def spokes(count: int, r0: float, r1: float, width: float, turn: float = 0.0) -> list[bpy.types.Mesh]:
        out = []
        for k in range(count):
            a = turn + k * TAU / count
            mid = (r0 + r1) / 2
            m = box(r1 - r0, width, d1 - d0, cy=RELIEF_Y + mid * math.sin(a), x=mid * math.cos(a), z=-(WALL + (d0 + d1) / 2), rot_z=a)
            out.append(m)
        return out

    if wall == "n":
        parts.append(slab(circle(RING_INNER + 0.12, RELIEF_Y, 48), d0, d1))
        # Rings carved on the wheel's face, and a boss at its middle.
        for r0, r1 in ((1.05, 1.32), (2.35, 2.62)):
            parts.append(annulus(r0, r1, d0 - 0.12, d0 + 0.02))
        boss = [(0.62, d0 + 0.02), (0.6, d0 - 0.08), (0.48, d0 - 0.2), (0.26, d0 - 0.28), (0.02, d0 - 0.31)]
        parts.append(rings([[W(r * math.cos(k * TAU / 32), RELIEF_Y + r * math.sin(k * TAU / 32), d) for k in range(32)] for r, d in boss],
                           True, True, "boss"))
        parts.extend(spokes(16, RING_INNER + 0.05, RING_OUTER + 0.08, 0.17, TAU / 32))
    else:
        parts.append(annulus(0.95, 1.25, d0, d1))
        parts.append(annulus(2.5, 2.68, d0, d1))
        parts.extend(spokes(6, 1.2, 2.55, 0.15))
        parts.extend(spokes(12, 2.63, DISC_RADIUS + 0.08, 0.15, TAU / 24))
    return [stone(p, scale=1 / 3.0) for p in parts]


def wall_meshes(wall: str) -> list[bpy.types.Mesh]:
    """Everything of one wall, built on Void's wall and turned into place."""
    top = VAULT_SPRING + 0.3
    body = slab([(-WALL, FLOOR_Y), (-WALL, top), (WALL, top), (WALL, FLOOR_Y)], 0.0, THICK)
    cutters = great_cutters(wall)
    for u in OUTER_BAYS:
        cutters += bay_cutters(u)
    body = lib.subtract(body, cutters)
    stone(body)
    # Nothing in the room sees the wall's back, its top or its ends.
    # Nor what lies behind the glass of the outer bays' windows and roundels.
    strip(body, lambda c, n: local(c)[2] > THICK - 0.02 or c.y > top - 0.02 or c.y < FLOOR_Y + 0.002
          or abs(local(c)[0]) > WALL - 0.002 and abs(n.x) > 0.9
          or abs(local(c)[0]) > GREAT_HALF + 0.6 and (c.y > WINDOW_SILL - 0.1 and local(c)[2] > RECESS + 1.16
                                                       or c.y > ROUNDEL_Y - ROUNDEL_R - 0.4 and local(c)[2] > 0.78))
    parts = [body]

    details = great_details(wall)
    for u in OUTER_BAYS:
        details += bay_details(u)
    for u in PIERS:
        details += pier(u)
    details += corner_pier()
    for m in details:
        if not m.color_attributes:
            stone(m, scale=1 / 3.0)
        # A face turned square away from the room is never seen from it: the backs of mouldings
        # against the wall, of tracery against the glass. Nor is the underside of what stands on the floor.
        strip(m, lambda c, n: n.z < -0.9 or c.y < FLOOR_Y + 0.002 and n.y < -0.9)
    parts += details
    return [turn_to(m, wall) for m in parts]


def niche_centres() -> list[tuple[str, float]]:
    """Three candle niches either side of the middle of every wall. Returns (wall, offset along the wall)."""
    return [(wall, sign * (k + 1.5) * BAY) for wall in "nsew" for sign in (-1, 1) for k in range(3)]


# ---------------------------------------------------------------------------
# The vault
# ---------------------------------------------------------------------------

def vault_t(r: float) -> float:
    """How far up the vault is at a reach r (the greater of |x| and |z|), from 0 where it leaves
    the wall to 1 at the collar: a quarter ellipse, upright at the wall and level at the collar."""
    t = min(max((WALL - r) / (WALL - COLLAR_OUT), 0.0), 1.0)
    return math.sqrt(max(0.0, 1.0 - (1.0 - t) ** 2))


def vault_y(r: float) -> float:
    if r > WALL:
        return VAULT_SPRING - (r - WALL) * 2.0
    return VAULT_SPRING + VAULT_RISE * vault_t(r)


def vault_reaches() -> list[float]:
    out = [WALL + 0.25, WALL, 22.97, 22.9, 22.8, 22.65, 22.45, 22.2, 21.9, 21.5, 21.0, 20.4]
    r = 19.6
    while r > COLLAR_OUT + 0.6:
        out.append(r)
        r -= 1.0 if r > 9 else 0.8
    out += [COLLAR_OUT + 0.3, COLLAR_OUT - 0.1]
    return out


def build_vault_surface() -> bpy.types.Mesh:
    """The vault's underside: four shallow cells meeting along the diagonals, as a grid whose lines
    run out from the middle (so the ribs lie along them) and round it."""
    per_side = 16
    loops = []
    for r in vault_reaches():
        y = vault_y(r)
        loop = []
        for side in range(4):
            for k in range(per_side):
                s = -1.0 + 2.0 * k / per_side
                # Void's side first, then round counter-clockwise seen from above.
                x, z = [(s * r, -r), (r, s * r), (-s * r, r), (-r, -s * r)][side]
                loop.append(V((x, y, z)))
        loops.append(loop)
    n = len(loops[0])
    points = [p for loop in loops for p in loop]
    faces = []
    for i in range(len(loops) - 1):
        a, b = i * n, (i + 1) * n
        for k in range(n):
            k1 = (k + 1) % n
            faces.append((a + k, b + k, b + k1, a + k1))
    mesh = sheet(points, faces, "vault")
    # Wound to face down, into the room.
    bm = bmesh.new()
    bm.from_mesh(mesh)
    for f in bm.faces:
        if f.normal.z > 0:
            f.normal_flip()
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def vault_normal(x: float, z: float) -> Vector:
    """The vault's underside's normal (down, into the room) at a point of its plan."""
    def at(px: float, pz: float) -> float:
        return vault_y(max(abs(px), abs(pz)))
    e = 0.02
    if abs(abs(x) - abs(z)) < 1e-4:
        # On a diagonal, where two cells meet in a groin: the mean of the two cells' normals.
        sx, sz = math.copysign(1.0, x), math.copysign(1.0, z)
        fx = (at(x + sx * e, z) - at(x, z)) / (sx * e)
        fz = (at(x, z + sz * e) - at(x, z)) / (sz * e)
        return (V((fx, -1.0, 0.0)).normalized() + V((0.0, -1.0, fz)).normalized()).normalized()
    gx = (at(x + e, z) - at(x - e, z)) / (2 * e)
    gz = (at(x, z + e) - at(x, z - e)) / (2 * e)
    return V((gx, -1.0, gz)).normalized()


def rib(path: list[Vector], profile: list[tuple[float, float]], name: str = "rib") -> bpy.types.Mesh:
    """A rib under the vault along a path of points on it: its section is (across, down)."""
    loops = []
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        n = vault_normal(p.x, p.z)
        b = t.cross(n).normalized()
        n = b.cross(t).normalized()
        if n.y > 0:
            n = -n
        loops.append([p + b * a + n * dn for a, dn in profile])
    return rings(loops, True, True, name)


RIB = [(-0.17, -0.12), (-0.17, 0.1), (-0.08, 0.29), (0.08, 0.29), (0.17, 0.1), (0.17, -0.12)]
LIERNE = [(-0.12, -0.1), (-0.12, 0.08), (-0.06, 0.2), (0.06, 0.2), (0.12, 0.08), (0.12, -0.1)]


def build_vault() -> list[bpy.types.Mesh]:
    parts = [stone(build_vault_surface(), scale=1 / 7.0)]
    reaches = [r for r in vault_reaches() if r <= WALL]
    # The ribs: one from every pier and every corner, and one from the crown of each great arch,
    # all running in to the collar.
    rays = []
    for wall in "nesw":
        for s in (-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75):
            rays.append((wall, s))
    for sx in (-1, 1):
        for sz in (-1, 1):
            rays.append(("c", (sx, sz)))
    for wall, s in rays:
        path = []
        for r in reaches:
            if r < COLLAR_OUT - 0.05:
                continue
            if wall == "c":
                x, z = s[0] * r, s[1] * r
            else:
                x, z = {"n": (s * r, -r), "e": (r, s * r), "s": (-s * r, r), "w": (-r, -s * r)}[wall]
            path.append(V((x, vault_y(r), z)))
        profile = [(a * 1.25, d * 1.2) for a, d in RIB] if wall == "c" else RIB
        parts.append(rib(path, profile))
    # Two rings of liernes, and a boss wherever a rib crosses the inner one.
    for lr in LIERNES:
        for side in range(4):
            path = []
            for k in range(17):
                s = -1.0 + 2.0 * k / 16
                x, z = [(s * lr, -lr), (lr, s * lr), (-s * lr, lr), (-lr, -s * lr)][side]
                path.append(V((x, vault_y(lr), z)))
            parts.append(rib(path, LIERNE, "lierne"))
        for wall, s in rays if lr == LIERNES[-1] else ():
            if wall == "c":
                x, z = s[0] * lr, s[1] * lr
            else:
                x, z = {"n": (s * lr, -lr), "e": (lr, s * lr), "s": (-s * lr, lr), "w": (-lr, -s * lr)}[wall]
            y = vault_y(lr)
            parts.append(lathe([(0.0, y + 0.1), (0.36, y + 0.1), (0.38, y - 0.12), (0.3, y - 0.3), (0.16, y - 0.42), (0.0, y - 0.46)], x, z, 8))
    # The collar round the opening: a square ring that hangs below the vault, moulded on its foot
    # and outer face, and the short square shaft the opening rises through.
    collar = [(OCULUS, COLLAR_FOOT), (OCULUS + 0.3, COLLAR_FOOT), (OCULUS + 0.36, COLLAR_FOOT + 0.06), (OCULUS + 0.36, COLLAR_FOOT + 0.2),
              (OCULUS + 0.46, COLLAR_FOOT + 0.3), (OCULUS + 0.66, COLLAR_FOOT + 0.32), (OCULUS + 0.74, COLLAR_FOOT + 0.44),
              (OCULUS + 0.74, COLLAR_FOOT + 0.62), (OCULUS + 0.86, COLLAR_FOOT + 0.72), (OCULUS + 1.12, COLLAR_FOOT + 0.76),
              (OCULUS + 1.2, COLLAR_FOOT + 0.86), (OCULUS + 1.24, CEILING + 0.7), (OCULUS + 0.35, SHAFT_TOP), (OCULUS, SHAFT_TOP)]
    loops = [[V((x * h, y, z * h)) for x, z in ((-1, -1), (1, -1), (1, 1), (-1, 1))] for h, y in collar]
    loops.append(loops[0])
    across = [[loops[j][i] for j in range(len(loops))] for i in range(4)]
    across.append(across[0])
    ring = rings(across, True, False, "collar")
    parts.append(stone(ring, scale=1 / 3.0))
    # A boss at each corner of the collar, and a little one where each rib lands on it.
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = OCULUS + 0.62
            parts.append(lathe([(0.0, COLLAR_FOOT + 0.5), (0.5, COLLAR_FOOT + 0.5), (0.52, COLLAR_FOOT + 0.3), (0.42, COLLAR_FOOT + 0.05),
                                (0.24, COLLAR_FOOT - 0.12), (0.0, COLLAR_FOOT - 0.18)], sx * c, sz * c, 12))
    return parts


# ---------------------------------------------------------------------------
# The altar, the floor
# ---------------------------------------------------------------------------

ALTAR_PROFILE = [
    (STEP_1[0], FLOOR_Y), (STEP_1[0], STEP_1[1] - 0.04), (STEP_1[0] - 0.04, STEP_1[1]),
    (STEP_2[0], STEP_1[1]), (STEP_2[0], STEP_2[1] - 0.04), (STEP_2[0] - 0.04, STEP_2[1]),
    # The altar's base: a plinth band, a chamfer, a roll and a hollow up to the face of its body.
    (6.74, STEP_2[1]), (6.74, BODY_FOOT + 0.04), (6.66, BODY_FOOT + 0.1), (6.6, BODY_FOOT + 0.1), (6.62, BODY_FOOT + 0.16),
    (6.58, BODY_FOOT + 0.22), (6.48, BODY_FOOT + 0.25), (6.42, BODY_FOOT + 0.3), (BODY, BODY_FOOT + 0.36),
    # The body, and the hollow under the mensa's edge.
    (BODY, BODY_TOP), (BODY + 0.06, BODY_TOP + 0.03), (BODY + 0.14, BODY_TOP + 0.08), (BODY + 0.2, BODY_TOP + 0.13),
    (MENSA - 0.02, ALTAR_TOP - 0.17), (MENSA, ALTAR_TOP - 0.15), (MENSA, ALTAR_TOP - 0.04), (MENSA - 0.04, ALTAR_TOP),
]


def build_altar() -> bpy.types.Object:
    body = pstack(square(1.0), [(h - 1.0, y) for h, y in ALTAR_PROFILE])
    cuts = []
    # The blind arcade round the body: fourteen pointed panels a side.
    count = 14
    pitch = 2 * (BODY - 0.25) / count
    for k in range(4):
        a = k * math.pi / 2
        for i in range(count):
            along = (i - (count - 1) / 2) * pitch
            outline = opening(0.32, BODY_FOOT + 0.46, BODY_TOP - 0.1 - math.sqrt(0.64 ** 2 - 0.32 ** 2), 0.64, 8, along)
            pts = [V((along_u, y, 0.0)) for along_u, y in outline]
            loops = []
            for depth in (-0.2, 0.07):
                loop = []
                for p in pts:
                    # The panel's outline on the face at x = BODY - depth, turned to each side.
                    q = V((p.x, p.y, BODY - depth))
                    q = V((q.x * math.cos(a) + q.z * math.sin(a), q.y, -q.x * math.sin(a) + q.z * math.cos(a)))
                    loop.append(q)
                loops.append(loop)
            cuts.append(rings(loops, True, True, "panel"))
    body = lib.subtract(body, cuts)
    parts = [stone(body, scale=1 / 4.0, offset=(0.4, 0.13))]
    # Colonnettes on the corners of the body.
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = BODY - 0.02
            parts.append(stone(lathe([(0.0, BODY_FOOT + 0.3), (0.22, BODY_FOOT + 0.3), (0.22, BODY_FOOT + 0.38), (0.15, BODY_FOOT + 0.46),
                                      (0.13, BODY_FOOT + 0.5), (0.13, BODY_TOP - 0.14), (0.17, BODY_TOP - 0.1), (0.15, BODY_TOP - 0.06),
                                      (0.2, BODY_TOP + 0.04), (0.0, BODY_TOP + 0.05)], sx * c, sz * c, 16), scale=1 / 4.0))
    for m in parts:
        strip(m, lambda c, n: c.y < FLOOR_Y + 0.002 and n.y < -0.9)
    return lib.make_object(lib.join_raw(parts, "plinth"), "plinth")


def build_floor() -> bpy.types.Object:
    """The floor: one plane, and the strip that runs on through each doorway."""
    half = WALL + RECESS + 0.1
    parts = [box(half * 2, 0.5, half * 2, y=FLOOR_Y - 0.5)]
    for sign in (-1, 1):
        parts.append(box(THICK + 1.0, 0.5, DOOR_HALF * 2 + 0.2, y=FLOOR_Y - 0.5, x=sign * (WALL + RECESS + (THICK + 0.6) / 2)))
    meshes = [strip(finish_stone(m, 0, bevel=0.0, uv_scale=1 / 5.0, uv_offset=(0.3, 0.8)), lambda c, n: n.y < 0.5) for m in parts]
    return lib.make_object(lib.join_raw(meshes, "floor"), "floor")


# ---------------------------------------------------------------------------
# Timber and metal
# ---------------------------------------------------------------------------

def door_leaves() -> tuple[list[bpy.types.Mesh], list[bpy.types.Mesh]]:
    """The two leaves of a doorway on Void's wall's frame, swung open into the room so that each
    stands square to the wall just inside its jamb, with strap hinges and a ring. Returns (oak, iron)."""
    oak, iron = [], []
    hinge = RECESS + 0.42           # how far into the wall the leaves hang
    thick = 0.12
    outline = opening(DOOR_HALF, FLOOR_Y, DOOR_SPRING, 2 * DOOR_HALF, 14)
    for side in (-1, 1):
        # The leaf's outline as it was when shut, from its hanging edge to its meeting edge.
        shut = [(-DOOR_HALF, FLOOR_Y)] + [p for p in outline[1:-1] if p[0] <= 1e-6] + [(0.0, FLOOR_Y)]
        if side > 0:
            shut = [(-u, y) for u, y in shut]

        def opened(u: float, y: float, t: float) -> Vector:
            """A point of the leaf, swung open: its distance from the hanging edge now runs out
            into the room, and `t` is how far in from the face that looks across the doorway."""
            return W(side * (DOOR_HALF - 0.1 - thick + t), y, hinge - abs(u - side * DOOR_HALF))

        leaf = rings([[opened(u, y, t) for u, y in shut] for t in (0.0, thick)], True, True, "leaf")
        oak.append(finish_stone(leaf, 0, bevel=0.012, uv_scale=1 / 3.0, uv_offset=(0.3 + 0.4 * side, 0.2)))
        # Two straps across the face that looks across the doorway, and a ring on it.
        for y in (FLOOR_Y + 0.9, DOOR_SPRING + 0.1):
            a, b = opened(side * DOOR_HALF, y, -0.02), opened(side * 0.2, y, -0.02)
            iron.append(box(0.05, 0.12, abs(a.z - b.z), y=y - 0.06, x=a.x, z=(a.z + b.z) / 2))
            iron.append(cylinder(0.035, opened(side * 0.2, y, -0.02), opened(side * 0.2, y, -0.06), 8))
        at = opened(side * 0.24, -0.4, -0.03)
        iron.append(lathe([(0.0, -0.08), (0.06, -0.08), (0.07, 0.0), (0.06, 0.08), (0.0, 0.08)], 0.0, 0.0, 10))
        iron[-1].transform(Matrix.Translation(gb(at.x, at.y, at.z)))
        loop = [V((0.0, -0.12 - 0.11 * math.cos(k * TAU / 14), 0.11 * math.sin(k * TAU / 14))) for k in range(14)]
        ring = rings([[at + p + V((dx, 0.0, 0.0)) for p in loop] for dx in (-0.018, 0.018)] + [[at + p * 0.82 + V((dx, -0.02, 0.0)) for p in loop]
                                                                                               for dx in (0.018, -0.018)], True, True, "ring")
        iron.append(ring)
    return oak, iron


def face_out(mesh: bpy.types.Mesh, axis: Vector) -> bpy.types.Mesh:
    """Wind every face of an open surface round an upright axis (game x, z) to face away from it."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    for f in bm.faces:
        c = f.calc_center_median()
        if f.normal.dot(V((c.x - axis.x, c.y + axis.z, 0.0))) < 0:
            f.normal_flip()
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def lantern(at: Vector, hang: Vector, bracket_from: Vector) -> tuple[list[bpy.types.Mesh], list[bpy.types.Mesh]]:
    """A tall hexagonal iron lantern with cream glass, hung on a long rod from a bracket. `at` is
    the middle of its glass. Returns (iron, glass)."""
    x, y, z = at
    iron, glass = [], []
    g0, g1 = y - 0.8, y + 0.8                        # the glass
    w = 2 * LANTERN_R * math.cos(math.pi / 6)        # across the flats
    corners = [math.pi / 6 + k * TAU / 6 for k in range(6)]   # as lib.prism lays out its corners
    # The frame: a bar up each corner, and bands round the top, the foot and the middle of the glass.
    for a in corners:
        cx, cz = x + LANTERN_R * math.sin(a), z + LANTERN_R * math.cos(a)
        iron.append(box(0.06, g1 - g0 + 0.1, 0.06, y=g0 - 0.05, x=cx, z=cz, rot_y=a))
    iron.append(prism(6, w + 0.1, 0.12, g1 - 0.02, x=x, z=z))
    iron.append(prism(6, w + 0.1, 0.1, g0 - 0.08, x=x, z=z))
    iron.append(prism(6, w + 0.04, 0.05, (g0 + g1) / 2 + 0.25, x=x, z=z))
    # Below the glass, a pan that narrows to a drop; above it, a pointed cap and a knop.
    iron.append(prism(6, 0.18, 0.4, g0 - 0.48, top=w + 0.06, x=x, z=z))
    iron.append(lathe([(0.0, g0 - 0.78), (0.06, g0 - 0.74), (0.09, g0 - 0.62), (0.06, g0 - 0.5), (0.0, g0 - 0.47)], x, z, 10))
    iron.append(prism(6, w + 0.24, 0.08, g1 + 0.1, x=x, z=z))
    iron.append(prism(6, w + 0.18, 0.5, g1 + 0.18, top=0.16, x=x, z=z))
    iron.append(lathe([(0.0, g1 + 0.66), (0.08, g1 + 0.66), (0.1, g1 + 0.74), (0.06, g1 + 0.82), (0.0, g1 + 0.84)], x, z, 10))
    # The rod, and the bracket it hangs from: an arm out from the pier's shaft with a brace under it.
    iron.append(cylinder(0.03, V((x, g1 + 0.8, z)), V((x, hang.y, z)), 8))
    iron.append(cylinder(0.05, V((x, hang.y, z)), bracket_from, 8))
    iron.append(cylinder(0.035, bracket_from + V((0.0, -1.2, 0.0)), (V((x, hang.y, z)) + bracket_from) / 2, 8))
    iron.append(lathe([(0.0, hang.y - 0.1), (0.09, hang.y - 0.08), (0.1, hang.y + 0.02), (0.06, hang.y + 0.1), (0.0, hang.y + 0.12)], x, z, 10))
    # The glass: six panes, a little inside the frame.
    pane_r = LANTERN_R - 0.03
    points, faces = [], []
    for k in range(6):
        a0, a1 = corners[k], corners[(k + 1) % 6]
        for a, yy in ((a0, g0), (a1, g0), (a1, g1), (a0, g1)):
            points.append(V((x + pane_r * math.sin(a), yy, z + pane_r * math.cos(a))))
        faces.append((4 * k, 4 * k + 1, 4 * k + 2, 4 * k + 3))
    glass.append(face_out(sheet(points, faces, "glass"), V((x, 0.0, z))))
    return iron, glass


def pricket(x: float, z: float, top: float) -> bpy.types.Mesh:
    """A brass candlestick standing on the altar: a round foot, a stem with a knop, a drip pan."""
    foot = ALTAR_TOP
    h = top - foot
    p = [(0.0, 0.0), (0.2, 0.0), (0.21, 0.03), (0.18, 0.06), (0.12, 0.09), (0.075, 0.14), (0.05, 0.22), (0.045, 0.38),
         (0.085, 0.45), (0.085, 0.5), (0.045, 0.56), (0.04, 0.8), (0.065, 0.85), (0.05, 0.9), (0.15, 0.93), (0.16, 0.98),
         (0.13, 1.0), (0.0, 1.0)]
    return lathe([(r, foot + f * h) for r, f in p], x, z, 12)


# ---------------------------------------------------------------------------
# Glow, candles
# ---------------------------------------------------------------------------

def glow_parts() -> dict[int, list[bpy.types.Mesh]]:
    """Everything that is itself light, by kind (lanterns excepted: they are added with their iron)."""
    parts: dict[int, list[bpy.types.Mesh]] = {GLOW_SLOT: [], GLOW_SKY: [], GLOW_RING: [], GLOW_DISC: [], GLOW_LANTERN: []}
    # A hairline of light round the altar's body, just under the mensa.
    for k in range(4):
        a = k * math.pi / 2
        out = V((math.sin(a), 0.0, -math.cos(a)))
        c = out * (BODY + 0.004)
        run = 2 * BODY - 0.5
        parts[GLOW_SLOT].append(box(run if k % 2 == 0 else 0.004, 0.035, 0.004 if k % 2 == 0 else run, y=BODY_TOP - 0.005, x=c.x, z=c.z))

    def back(outline: list[tuple[float, float]], d: float) -> bpy.types.Mesh:
        return slab(outline, d, d + 0.02)

    for wall in "nsew":
        mine = []
        for u in OUTER_BAYS:
            mine.append(back(opening(WINDOW_HALF + 0.05, WINDOW_SILL - 0.05, WINDOW_SPRING, 2 * WINDOW_HALF + 0.05, 12, u), RECESS + 1.12))
            mine.append(back(circle(ROUNDEL_R + 0.05, ROUNDEL_Y, 24, u), 0.75))
        if wall in "ew":
            mine.append(back(opening(DOOR_HALF + 0.1, FLOOR_Y - 0.1, DOOR_SPRING, 2 * DOOR_HALF + 0.1, 12), THICK + 0.4))
            for cu, half, sill, spring in ((0.0, CROSS_HALF, CROSS_FOOT, CROSS_SPRING), (-ARM_AT, ARM_HALF, ARM_SILL, ARM_SPRING),
                                           (ARM_AT, ARM_HALF, ARM_SILL, ARM_SPRING)):
                mine.append(back(opening(half + 0.05, sill - 0.05, spring, 2 * half + 0.05, 12, cu), THICK - 0.4))
        parts[GLOW_SKY] += [turn_to(m, wall) for m in mine]
    # The roses' glass, behind their tracery, and the troughs of light at their feet.
    ring = rings([[W(r * math.cos(k * TAU / 48), RELIEF_Y + r * math.sin(k * TAU / 48), RECESS + 0.82) for k in range(48)]
                  for r in (RING_INNER - 0.05, RING_OUTER + 0.08)] + [[W(r * math.cos(k * TAU / 48), RELIEF_Y + r * math.sin(k * TAU / 48), RECESS + 0.84)
                                                                        for k in range(48)] for r in (RING_OUTER + 0.08, RING_INNER - 0.05)],
                 True, False, "ring")
    parts[GLOW_RING].append(ring)
    parts[GLOW_DISC].append(turn_to(slab(circle(DISC_RADIUS + 0.08, RELIEF_Y, 48), RECESS + 0.82, RECESS + 0.84), "s"))
    for kind, wall in ((GLOW_RING, "n"), (GLOW_DISC, "s")):
        parts[kind].append(turn_to(slab([(-TROUGH + 0.1, SKIRT - 0.31), (-TROUGH + 0.1, SKIRT - 0.29), (TROUGH - 0.1, SKIRT - 0.29),
                                         (TROUGH - 0.1, SKIRT - 0.31)], -0.6, -0.14), wall))
    return parts


def build_glow(parts: dict[int, list[bpy.types.Mesh]], lanterns: list[Vector]) -> bpy.types.Object:
    meshes = [finish_stone(m.copy(), 0, bevel=0.0, red=kind / 8.0) for kind, group in parts.items() for m in group]
    # Lantern glass: green says how near the flame inside a point is (it burns a little below the
    # middle of the glass).
    for mesh in meshes:
        bm = bmesh.new()
        bm.from_mesh(mesh)
        col = bm.loops.layers.float_color.get(lib.COLOR)
        for f in bm.faces:
            for loop in f.loops:
                c = loop[col]
                if abs(c[0] * 8.0 - GLOW_LANTERN) < 0.1:
                    p = loop.vert.co
                    q = V((p.x, p.z, -p.y))
                    at = min(lanterns, key=lambda l: (V((l.x, 0.0, l.z)) - V((q.x, 0.0, q.z))).length)
                    heat = max(0.0, 1.0 - abs(q.y - (at.y - 0.25)) / 1.1)
                    loop[col] = (c[0], heat, c[2], c[3])
        bm.to_mesh(mesh)
        bm.free()
    return lib.make_object(lib.join_raw(meshes, "glow"), "glow")


def rise(mesh: bpy.types.Mesh, foot: float, height: float) -> bpy.types.Mesh:
    """Write how far up a candle each point of it is (0 at the foot, 1 at the rim) into the green of
    its data channel: tallow lets the flame's light through near the top and not lower down."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    col = bm.loops.layers.float_color.get(lib.COLOR) or bm.loops.layers.color.get(lib.COLOR)
    for f in bm.faces:
        for loop in f.loops:
            c = loop[col]
            loop[col] = (c[0], min(1.0, max(0.0, (loop.vert.co.z - foot) / height)), c[2], c[3])
    bm.to_mesh(mesh)
    bm.free()
    return mesh


# Three candles at each corner of the altar: (x, z) as at the (+x, +z) corner, the height the
# candle stands at, and its own height. The tall one first.
ALTAR_CANDLES = ((5.62, 5.62, -0.15, 0.5), (6.1, 5.42, -0.42, 0.38), (5.42, 6.1, -0.6, 0.28))


def build_candles() -> tuple[bpy.types.Object, list[list[float]], list[bpy.types.Mesh]]:
    rng = random.Random(7)
    meshes = []
    flames = []
    brass = []

    def candle(x: float, y: float, z: float, h: float, r: float) -> None:
        # The niches' candles are only ever seen across the room: eight plain sides do for them,
        # with no hollow melted in the top.
        near = r < 0.12
        body = prism(12 if near else 8, r * 2, h, y, top=r * 1.76, x=x, z=z, turn=rng.random())
        if near:
            body = lib.subtract(body, [cylinder(r * 0.62, V((x, y + h - 0.03, z)), V((x, y + h + 0.05, z)), 12)])
        wick = box(0.012, 0.07, 0.012, y=y + h - 0.035, x=x, z=z)
        meshes.append(rise(finish_stone(body, 0, bevel=0.012 if near else 0.0, uv_scale=1.4,
                                        uv_offset=(rng.random(), rng.random())), y, h))
        meshes.append(finish_stone(wick, 0, bevel=0.0, red=1.0))
        flames.append([round(x, 3), round(y + h + 0.075, 3), round(z, 3)])

    for sx, sz in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        for x, z, top, h in ALTAR_CANDLES:
            brass.append(pricket(sx * x, sz * z, top))
            candle(sx * x, top, sz * z, h, 0.1 if h > 0.45 else 0.09)
    for wall, off in niche_centres():
        heights = [1.5, 0.95, 1.25]
        rng.shuffle(heights)
        for k, du in enumerate((-0.62, 0.02, 0.6)):
            h = heights[k] * rng.uniform(0.85, 1.1)
            # In the niche's frame on Void's wall, then turned to its own wall.
            p = turn_point(W(off + du + rng.uniform(-0.08, 0.08), NICHE_FLOOR, RECESS + 0.42 + 0.3 * (k % 2)), wall)
            candle(p.x, NICHE_FLOOR, p.z, h, 0.13)

    obj = lib.make_object(lib.join_raw(meshes, "candles"), "candles")
    obj["meta"] = json.dumps({
        "flames": flames, "plinthFlames": 12,
        "niches": [{"wall": wall, "along": off} for wall, off in niche_centres()],
        "niche": {"width": NICHE_WIDTH, "height": round(apex_of(NICHE_WIDTH / 2, NICHE_SPRING, NICHE_RADIUS) - NICHE_FLOOR, 3),
                  "depth": NICHE_BACK, "floor": NICHE_FLOOR},
    })
    return obj, flames, brass


def build_metal(brass: list[bpy.types.Mesh]) -> tuple[bpy.types.Object, bpy.types.Object, list[bpy.types.Mesh], list[list[float]]]:
    """The iron and brass, the oak doors, the lanterns' glass and where each lantern's glass has its middle."""
    iron_parts, oak_parts, glass, centres = [], [], [], []
    for wall in "nsew":
        mine_iron, mine_glass = [], []
        for u in PIERS:
            at = W(u, LANTERN_Y, LANTERN_D)
            hang = W(u, LANTERN_HANG, LANTERN_D)
            iron, pane = lantern(at, hang, W(u, LANTERN_HANG, SHAFT_D - SHAFT_R + 0.05))
            mine_iron += iron
            mine_glass += pane
            centres.append([round(c, 3) for c in turn_point(at, wall)])
        if wall in "ew":
            oak, straps = door_leaves()
            oak_parts += [turn_to(m, wall) for m in oak]
            mine_iron += straps
        iron_parts += [turn_to(m, wall) for m in mine_iron]
        glass += [turn_to(m, wall) for m in mine_glass]

    def lit(mesh: bpy.types.Mesh, red: float) -> bpy.types.Mesh:
        """Red: brass or iron. Green: how much of the nearest lantern's light falls on a point."""
        finish_stone(mesh, 0, bevel=0.0, red=red, uv_scale=1.0)
        bm = bmesh.new()
        bm.from_mesh(mesh)
        col = bm.loops.layers.float_color.get(lib.COLOR)
        for f in bm.faces:
            for loop in f.loops:
                p = loop.vert.co
                q = V((p.x, p.z, -p.y))
                near = min((q - V(c)).length for c in centres) if red < 0.5 else 9.0
                c = loop[col]
                loop[col] = (c[0], max(0.0, 1.0 - near / 1.6) ** 1.5, c[2], c[3])
        bm.to_mesh(mesh)
        bm.free()
        return mesh

    metal = [lit(m, 0.0) for m in iron_parts] + [lit(m, 1.0) for m in brass]
    timber = lib.make_object(lib.join_raw(oak_parts, "timber"), "timber")
    return lib.make_object(lib.join_raw(metal, "metal"), "metal"), timber, glass, centres


# ---------------------------------------------------------------------------
# The shell
# ---------------------------------------------------------------------------

def build_shell() -> tuple[bpy.types.Object, bpy.types.Object]:
    """The walls and the vault, in two parts: what stands below SPLIT_Y, and everything above it."""
    meshes = []
    for wall in "nesw":
        meshes += wall_meshes(wall)
        print(f"wall {wall} built", flush=True)
    meshes += build_vault()
    whole = lib.join_raw(meshes, "shell")
    low, high = split(whole, SPLIT_Y)
    return lib.make_object(low, "walls_low"), lib.make_object(high, "walls_high")


# ---------------------------------------------------------------------------
# Baked light
# ---------------------------------------------------------------------------

# Where each baked object sits in the two atlases, as (u0, v0, u1, v1). What is looked at
# directly gets most of the room; the upper walls and the vault are seen far less.
CELLS = {
    "walls_low": (0.0, 0.3125, 0.6875, 1.0),
    "floor": (0.6875, 0.6875, 1.0, 1.0),
    "plinth": (0.6875, 0.375, 1.0, 0.6875),
    "walls_high": (0.375, 0.0, 0.6875, 0.3125),
    "timber": (0.6875, 0.1875, 0.875, 0.375),
}

# How each baked object is unwrapped: the gutter round each island, and the angle past which a
# surface is split into a new one.
UNWRAP = {"walls_low": (0.0015, 80.0), "walls_high": (0.0015, 80.0), "floor": (0.004, 60.0), "plinth": (0.0015, 80.0), "timber": (0.004, 60.0)}

# What each kind of light is multiplied by before it is stored, so that all but the brightest
# thousandth of it comes out under 1. The engine divides by the same numbers (they travel in the
# shell's metadata), so changing one here changes how finely that light is stored and nothing else.
GAIN = {"candles": 0.3, "sky": 0.25, "key": 0.25, "ring": 0.1, "disc": 0.25, "slot": 0.2}

# How much each is blurred, in texels, to take the grain off it. Light that has bounced is smooth
# anyway; light that comes straight from a flame or a window has edges worth keeping.
SOFTEN = {"candles": 1.4, "sky": 1.6, "key": 3.0, "ring": 1.6, "disc": 1.6, "slot": 1.2}

KEY_WATTS = 9000000.0
LANTERN_WATTS = 140.0
NICHE_WATTS = 60.0


def emitter(meshes: list[bpy.types.Mesh], strength: float, name: str) -> bpy.types.Object:
    """A mesh that only gives light, for baking."""
    obj = bpy.data.objects.new(name, lib.join_raw([m.copy() for m in meshes], name))
    bpy.context.scene.collection.objects.link(obj)
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = strength
    out = nodes.new("ShaderNodeOutputMaterial")
    material.node_tree.links.new(emission.outputs["Emission"], out.inputs["Surface"])
    obj.data.materials.append(material)
    obj.hide_render = True
    return obj


def lamp(kind: str, at: Vector, energy: float, name: str, **settings) -> bpy.types.Object:
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    for key, value in settings.items():
        setattr(data, key, value)
    obj = bpy.data.objects.new(name, data)
    obj.location = gb(at.x, at.y, at.z)
    bpy.context.scene.collection.objects.link(obj)
    obj.hide_render = True
    return obj


def grey(objects: list[bpy.types.Object], albedo: float, name: str) -> None:
    """A plain matt surface for the things that are in the room but are not baked."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (albedo, albedo, albedo, 1.0)
    shader.inputs["Roughness"].default_value = 1.0
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)


def soften(x, mask, sigma: float):
    """Blur a baked plane a little to take the grain off it, without letting the empty atlas
    between the islands leak into them."""
    import numpy as np
    r = max(1, int(math.ceil(sigma * 2.5)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()

    def blur(a):
        for axis in (0, 1):
            acc = np.zeros_like(a)
            for i, w in enumerate(k):
                acc += w * np.roll(a, i - r, axis=axis)
            a = acc
        return a

    weight = blur(mask)
    return np.where(mask > 0, blur(x * mask) / np.maximum(weight, 1e-6), 0.0)


def despeckle(x):
    """Hold every texel down to the third brightest of the nine around it: a lone hot sample
    (a firefly) goes, and nothing else changes by more than a hair."""
    import numpy as np
    around = np.stack([np.roll(np.roll(x, dy, axis=0), dx, axis=1) for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
    return np.minimum(x, np.partition(around, 6, axis=0)[6])


def spread(x, mask, steps: int = 10):
    """Carry each island's values a few pixels past its edge, so that filtering never reads the empty atlas."""
    import numpy as np
    x = x * mask
    m = mask.copy()
    for _ in range(steps):
        total = np.zeros_like(x)
        count = np.zeros_like(m)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    total += np.roll(np.roll(x, dy, axis=0), dx, axis=1)
                    count += np.roll(np.roll(m, dy, axis=0), dx, axis=1)
        grow = (m == 0) & (count > 0)
        x[grow] = total[grow] / count[grow]
        m[grow] = 1.0
    return x


def bake(baked: list[bpy.types.Object], others: dict[str, list[bpy.types.Object]], glow: dict[int, list[bpy.types.Mesh]],
         flames: list[list[float]], lanterns: list[list[float]], out: str, size: int, samples: int) -> None:
    import numpy as np

    scene = bpy.context.scene
    scene.world.color = (0.0, 0.0, 0.0)
    grey(others["dark"], 0.05, "walnut")
    grey(others["iron"], 0.08, "iron")
    grey(others["wax"], 0.7, "wax")

    def plane(name: str) -> bpy.types.Image:
        image = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
        image.colorspace_settings.name = "Non-Color"
        return image

    # Which texels belong to a surface at all: everything is made to glow, and baked once.
    scene.cycles.samples = 1
    atlas = plane("cover")
    material = bpy.data.materials.new("cover")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    surface = nodes.new("ShaderNodeOutputMaterial")
    material.node_tree.links.new(emission.outputs["Emission"], surface.inputs["Surface"])
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = atlas
    nodes.active = tex
    for i, obj in enumerate(baked):
        obj.data.materials.clear()
        obj.data.materials.append(material)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="EMIT", margin=0, use_clear=(i == 0), uv_layer=lib.UV_UNIQUE)
    mask = (lib.image_pixels(atlas)[..., :3].max(axis=-1) > 0.5).astype(np.float32)
    bpy.data.images.remove(atlas)
    for obj in baked:
        obj.data.materials.clear()
    bpy.data.materials.remove(material)
    print(f"atlas: {mask.mean() * 100:.0f}% of it is used", flush=True)
    for name, (u0, v0, u1, v1) in CELLS.items():
        cell = mask[int(v0 * size):int(v1 * size), int(u0 * size):int(u1 * size)]
        print(f"  {name}: {cell.mean() * 100:.0f}% of its cell", flush=True)

    # Ambient occlusion: every part of the room shades every other.
    scene.cycles.samples = max(16, samples // 3)
    atlas = plane("ao")
    lib.bake_ao(baked, atlas, floor_y=None, together=True, distance=4.0, margin=0)
    ao = spread(soften(lib.image_pixels(atlas)[..., 0].copy(), mask, 1.0), mask)
    bpy.data.images.remove(atlas)

    # One pass for each kind of light, with only that light showing.
    lights: dict[str, list[bpy.types.Object]] = {
        "candles": [lamp("POINT", V(f), NICHE_WATTS, "candle", shadow_soft_size=0.14) for f in flames[12:]]
        + [lamp("POINT", V(c) + V((0.0, -0.1, 0.0)), LANTERN_WATTS, "lantern", shadow_soft_size=0.25) for c in lanterns],
        "sky": [emitter(glow[GLOW_SKY], 5.0, "sky"),
                lamp("AREA", V((0.0, SHAFT_TOP + 1.0, 0.0)), 9000.0, "oculus", shape="SQUARE", size=OCULUS * 2)],
        "key": [lamp("SPOT", V((0.0, KEY_HEIGHT, 0.0)), KEY_WATTS, "key", shadow_soft_size=0.4,
                     spot_size=2 * math.atan(OCULUS * 1.7 / (KEY_HEIGHT - CEILING)), spot_blend=0.2)],
        "ring": [emitter(glow[GLOW_RING], 26.0, "ring")],
        "disc": [emitter(glow[GLOW_DISC], 14.0, "disc")],
        "slot": [emitter(glow[GLOW_SLOT], SLOT_GLOW, "slot")],
    }
    scene.cycles.samples = samples
    scene.cycles.max_bounces = 5
    scene.cycles.diffuse_bounces = 4
    scene.cycles.sample_clamp_indirect = 8.0
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    passes: dict[str, np.ndarray] = {}
    for name, group in lights.items():
        for obj in group:
            obj.hide_render = False
        image = plane(name)
        # The key's own light is the engine's to draw, with shadows that move; only its bounce is kept.
        lib.bake_light(baked, image, direct=(name != "key"), indirect=True, margin=0, label=f"light: {name}")
        px = lib.image_pixels(image)
        level = (0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]) * GAIN[name]
        bpy.data.images.remove(image)
        for obj in group:
            obj.hide_render = True
        seen = level[mask > 0]
        marks = np.percentile(seen, [50, 90, 99, 99.9])
        print(f"  {name}: median {marks[0]:.4f}, 90% {marks[1]:.4f}, 99% {marks[2]:.4f}, 99.9% {marks[3]:.4f}, max {seen.max():.3f}", flush=True)
        passes[name] = spread(soften(despeckle(level), mask, SOFTEN[name]), mask)
    for group in lights.values():
        for obj in group:
            data = obj.data
            bpy.data.objects.remove(obj)
            (bpy.data.lights if isinstance(data, bpy.types.Light) else bpy.data.meshes).remove(data)

    # On the altar the second channel holds the light of the line under its mensa, not the rose's.
    near = np.zeros((size, size), dtype=bool)
    u0, v0, u1, v1 = CELLS["plinth"]
    near[int(v0 * size):int(v1 * size), int(u0 * size):int(u1 * size)] = True
    second = np.where(near, passes["slot"], passes["ring"])

    def stored(x: np.ndarray) -> np.ndarray:
        return np.clip(x, 0.0, 1.0) ** (1.0 / 2.2)

    lib.save_rgb_jpeg(np.stack([np.clip(ao, 0, 1), stored(second), stored(passes["disc"])], axis=-1),
                      os.path.join(out, "tex", "room_ao.jpg"))
    lib.save_rgb_jpeg(np.stack([stored(passes["candles"]), stored(passes["sky"]), stored(passes["key"])], axis=-1),
                      os.path.join(out, "tex", "room_light.jpg"))
    for group in others.values():
        for obj in group:
            obj.data.materials.clear()


# ---------------------------------------------------------------------------
# Clay pictures
# ---------------------------------------------------------------------------

# Where the game's cameras stand, and what they look at; then some nearer looks at the bays.
VIEWS = {
    "side": ((13.7, 5.7, 0.0), (0.0, 0.0, 0.0), 40),
    "shoulder": ((2.5, 5.0, 10.2), (0.0, 0.0, -0.6), 40),
    "eyes": ((0.0, 8.9, 9.7), (0.0, 0.0, 0.0), 40),
    "orbit-low": ((16.4, 2.4, 11.5), (0.0, 0.5, 0.0), 40),
    "opening": ((7.3, 6.2, 10.0), (0.0, 0.6, 0.0), 40),
    "wide-void": ((0.0, 4.0, 18.5), (0.0, 6.0, -23.0), 50),
    "wide-door": ((17.0, 3.0, 4.0), (-23.0, 7.0, 0.0), 55),
    "bay": ((-6.0, 1.5, -12.0), (-11.5, 2.5, -23.0), 50),
    "up": ((0.0, 2.0, 14.0), (0.0, 22.0, -6.0), 70),
    "altar": ((9.0, 2.0, 9.0), (0.0, -1.6, 0.0), 40),
}


def preview(folder: str, shown: list[bpy.types.Object]) -> None:
    """Clay pictures of the room from the views above, with a dark box where the case stands."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "SINGLE"
    shading.single_color = (0.75, 0.62, 0.48)
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    # Workbench's stencil shadows streak across thin parts like the rods and ribs, so none are drawn.
    shading.show_shadows = False
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.image_settings.file_format = "PNG"
    case = bpy.data.objects.new("case", box(CASE * 2, CASE_TOP - ALTAR_TOP, CASE * 2, y=ALTAR_TOP))
    scene.collection.objects.link(case)
    cam_data = bpy.data.cameras.new("eye")
    cam_data.sensor_fit = "VERTICAL"
    cam = bpy.data.objects.new("eye", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    os.makedirs(folder, exist_ok=True)
    for name, (at, look, fov) in VIEWS.items():
        cam_data.angle = math.radians(fov)
        cam.location = gb(*at)
        direction = gb(*look) - gb(*at)
        cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(folder, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"preview {name}", flush=True)


# ---------------------------------------------------------------------------

# How many of its triangles the upper walls and the vault keep, and the mirror's copy of the shell.
NEAR_RATIO = 0.5
FAR_RATIO = 0.3
METAL_RATIO = 0.55
MIRROR_RATIO = 0.1


def decimate(obj: bpy.types.Object, ratio: float) -> None:
    """Collapse edges until `ratio` of the triangles are left. UVs and the data channel are carried
    along; the hard edges are found again afterwards."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new("far", "DECIMATE")
    mod.decimate_type = "COLLAPSE"
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.data.set_sharp_from_angle(angle=math.radians(48.0))


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--samples", type=int, default=192)
    ap.add_argument("--size", type=int, default=2048)
    ap.add_argument("--no-bake", action="store_true")
    ap.add_argument("--preview", default=None)
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)

    lib.reset_scene()
    lib.setup_cycles(a.samples)

    plinth = build_altar()
    floor = build_floor()
    walls_low, walls_high = build_shell()
    candles, flames, brass = build_candles()
    metal, timber, panes, lanterns = build_metal(brass)
    lights = glow_parts()
    lights[GLOW_LANTERN] = panes
    glow = build_glow(lights, [V(c) for c in lanterns])
    meta = json.dumps({
        "floorY": FLOOR_Y, "wall": WALL, "ceiling": CEILING, "oculusHalf": OCULUS, "plinthTop": ALTAR_TOP,
        "keyHeight": KEY_HEIGHT, "bay": BAY,
        # What the atlases hold: each light's stored value is its strength times `gains`, and
        # `keyUnit` is what the key itself would read where it falls straight on the board.
        "gains": GAIN, "keyUnit": KEY_WATTS / (4.0 * math.pi ** 2 * KEY_HEIGHT ** 2),
        # Half the width of the square of light the key lays on the board: what the foot of the
        # collar lets through. And how bright the line under the mensa was when it was baked.
        "beam": OCULUS * KEY_HEIGHT / (KEY_HEIGHT - COLLAR_FOOT), "slotGlow": SLOT_GLOW,
        "ring": {"wall": "n", "y": RELIEF_Y, "outer": RING_OUTER, "inner": RING_INNER},
        "disc": {"wall": "s", "y": RELIEF_Y, "radius": DISC_RADIUS},
        # The cross of lancets over each doorway: the upright's head, foot and half width; the
        # arm's middle height and half length, the half width of its two lights and how high
        # they run; and the doorway under it.
        "cross": {"walls": "ew", "head": round(apex_of(CROSS_HALF, CROSS_SPRING, 2 * CROSS_HALF), 3), "foot": CROSS_FOOT,
                  "half": CROSS_HALF, "armY": round((ARM_SILL + apex_of(ARM_HALF, ARM_SPRING, 2 * ARM_HALF)) / 2, 3),
                  "arm": ARM_AT + ARM_HALF, "armAt": ARM_AT, "armHalf": ARM_HALF, "armSill": ARM_SILL,
                  "armHead": round(apex_of(ARM_HALF, ARM_SPRING, 2 * ARM_HALF), 3)},
        "door": {"half": DOOR_HALF, "head": round(apex_of(DOOR_HALF, DOOR_SPRING, 2 * DOOR_HALF), 3)},
        # The tall windows of the outer bays and the roundels over them.
        "window": {"half": WINDOW_HALF, "sill": WINDOW_SILL, "head": round(apex_of(WINDOW_HALF, WINDOW_SPRING, 2 * WINDOW_HALF), 3),
                   "roundel": ROUNDEL_Y, "roundelRadius": ROUNDEL_R},
        # The altar: its top, the half width of its top, and of the body under it.
        "altar": {"top": ALTAR_TOP, "mensa": MENSA, "body": BODY, "steps": [list(STEP_1), list(STEP_2)]},
        # The lanterns: the middle of each one's glass, and the glass's half width and half height.
        "lanterns": lanterns, "lantern": {"radius": LANTERN_R, "half": 0.8},
    })

    for obj in (plinth, floor, walls_low, walls_high, timber, metal, candles, glow):
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"{obj.name}: {len(obj.data.vertices)} vertices, {tris} triangles", flush=True)

    # No camera comes nearer a wall than across most of the room, and nothing above the arcade's
    # springing is seen from nearer than about twenty units: both keep fewer triangles.
    decimate(walls_low, NEAR_RATIO)
    decimate(walls_high, FAR_RATIO)
    decimate(metal, METAL_RATIO)

    if a.preview:
        preview(os.path.abspath(a.preview), [])
        return

    # One atlas for the large static meshes; the rest shade and bounce but are not baked.
    baked = [walls_low, walls_high, floor, plinth, timber]
    for obj in baked:
        # The walls are mostly mouldings: unwrapped at a wide angle they fall into far fewer,
        # larger islands, with thinner gutters between them, and fill their cells.
        unwrap(obj, CELLS[obj.name], margin=UNWRAP[obj.name][0], angle=UNWRAP[obj.name][1])
    if not a.no_bake:
        glow.hide_render = True
        case = lib.make_object(finish_stone(box(CASE * 2, CASE_TOP - ALTAR_TOP, CASE * 2, y=ALTAR_TOP), 0, bevel=0.0), "case")
        bake(baked, {"dark": [case], "iron": [metal], "wax": [candles]}, lights, flames, lanterns, out, a.size, a.samples)
        bpy.data.objects.remove(case)
        glow.hide_render = False
    for group in lights.values():
        for mesh in group:
            if mesh.users == 0:
                bpy.data.meshes.remove(mesh)

    # The walls and the vault leave as one mesh, as the engine expects.
    parts = [walls_low.data, walls_high.data]
    for obj in (walls_low, walls_high):
        bpy.data.objects.remove(obj)
    shell = lib.make_object(lib.join_raw(parts, "shell"), "shell")
    shell["meta"] = meta
    # The shell as the board's mirror sees it: half size, blurred, and only ever below the board's
    # edge. A tenth of the triangles does.
    shell_far = lib.make_object(shell.data.copy(), "shell_far")
    decimate(shell_far, MIRROR_RATIO)
    shell_far.data.validate()

    # Shaded smooth across anything gentler than 48 degrees: the rolls of the mouldings and the
    # turns of the ribs read as round, and their vertices need not be split at every facet.
    for obj in (plinth, shell, shell_far, metal, candles):
        obj.data.set_sharp_from_angle(angle=math.radians(48.0))
    lib.export_glb([plinth, floor, shell, shell_far, timber, metal, candles, glow], os.path.join(out, "room.glb"))
    quantize(os.path.join(out, "room.glb"))


def quantize(path: str) -> None:
    """Store the room compactly, in the ways KHR_mesh_quantization allows and three.js reads:
    positions as 16-bit fractions of each mesh's own extent, its node's scale and translation
    bringing them back; normals as bytes; the tiling coordinates as 16-bit fractions of a power of
    two written in the node's extras as `uv0` (the engine multiplies them back as it loads them);
    the atlas coordinates as 16-bit fractions; the data channel as bytes; and indices as 16-bit
    where a mesh has few enough vertices."""
    import struct

    import numpy as np

    with open(path, "rb") as fh:
        data = fh.read()
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + json_len])
    bin_at = 20 + json_len
    blob = data[bin_at + 8:bin_at + 8 + struct.unpack_from("<I", data, bin_at)[0]]
    sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    widths = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    kinds = {5120: "i1", 5121: "u1", 5122: "<i2", 5123: "<u2", 5125: "<u4", 5126: "<f4"}

    def read(index: int):
        acc = gltf["accessors"][index]
        view = gltf["bufferViews"][acc["bufferView"]]
        assert "byteStride" not in view, "the exporter wrote interleaved data"
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        n, width = acc["count"], widths[acc["type"]]
        raw = blob[start:start + n * width * sizes[acc["componentType"]]]
        return np.frombuffer(raw, dtype=kinds[acc["componentType"]]).reshape(n, width)

    # Every accessor's new bytes, its new component type, and whether a stride pads it to four.
    store: dict[int, tuple[bytes, int, bool, int | None]] = {}
    for mesh_index, mesh in enumerate(gltf["meshes"]):
        node = next(n for n in gltf["nodes"] if n.get("mesh") == mesh_index)
        for prim in mesh["primitives"]:
            att = prim["attributes"]
            p = read(att["POSITION"]).astype(np.float64)
            lo, hi = p.min(axis=0), p.max(axis=0)
            centre = (lo + hi) / 2
            scale = float(max((hi - lo).max() / 2, 1e-6))
            q = np.round((p - centre) / scale * 32767).clip(-32767, 32767).astype(np.int16)
            padded = np.zeros((len(q), 4), dtype="<i2")
            padded[:, :3] = q
            store[att["POSITION"]] = (padded.tobytes(), 5122, True, 8)
            acc = gltf["accessors"][att["POSITION"]]
            acc["min"], acc["max"] = q.min(axis=0).tolist(), q.max(axis=0).tolist()
            node["translation"] = [round(float(c), 6) for c in centre]
            node["scale"] = [scale] * 3
            n = read(att["NORMAL"])
            packed = np.zeros((len(n), 4), dtype=np.int8)
            packed[:, :3] = np.clip(np.round(n * 127.0), -127, 127)
            store[att["NORMAL"]] = (packed.tobytes(), 5120, True, 4)
            uv = read(att["TEXCOORD_0"]).astype(np.float64)
            k = float(2 ** math.ceil(math.log2(max(np.abs(uv).max(), 1e-3))))
            store[att["TEXCOORD_0"]] = (np.round(uv / k * 32767).clip(-32767, 32767).astype("<i2").tobytes(), 5122, True, None)
            node.setdefault("extras", {})["uv0"] = k
            uv1 = read(att["TEXCOORD_1"])
            store[att["TEXCOORD_1"]] = (np.clip(np.round(uv1 * 65535.0), 0, 65535).astype("<u2").tobytes(), 5123, True, None)
            colour = read(att["COLOR_0"]).astype(np.float64)
            colour = colour / 65535.0 if gltf["accessors"][att["COLOR_0"]]["componentType"] == 5123 else colour
            store[att["COLOR_0"]] = (np.clip(np.round(colour * 255.0), 0, 255).astype("u1").tobytes(), 5121, True, None)
            index = read(prim["indices"])
            small = len(p) < 65536
            store[prim["indices"]] = (index.astype("<u2" if small else "<u4").tobytes(), 5123 if small else 5125, False, None)

    out = bytearray()
    views = []
    roles = {i for prim in (p for m in gltf["meshes"] for p in m["primitives"]) for i in [prim["indices"]]}
    for index, acc in enumerate(gltf["accessors"]):
        raw, kind, normalized, stride = store[index]
        acc["componentType"] = kind
        if normalized:
            acc["normalized"] = True
        else:
            acc.pop("normalized", None)
        out += b"\0" * (-len(out) % 4)
        entry = {"buffer": 0, "byteOffset": len(out), "byteLength": len(raw), "target": 34963 if index in roles else 34962}
        if stride:
            entry["byteStride"] = stride
        views.append(entry)
        acc["bufferView"] = len(views) - 1
        acc.pop("byteOffset", None)
        out += raw
    for index, acc in enumerate(gltf["accessors"]):
        if index not in {a for m in gltf["meshes"] for p in m["primitives"] for a in [p["attributes"]["POSITION"]]}:
            acc.pop("min", None), acc.pop("max", None)
    out += b"\0" * (-len(out) % 4)
    gltf["bufferViews"] = views
    gltf["buffers"] = [{"byteLength": len(out)}]
    for key in ("extensionsUsed", "extensionsRequired"):
        gltf[key] = sorted(set(gltf.get(key, [])) | {"KHR_mesh_quantization"})
    text = json.dumps(gltf, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    total = 12 + 8 + len(text) + 8 + len(out)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(text), 0x4E4F534A) + text)
        fh.write(struct.pack("<II", len(out), 0x004E4942) + bytes(out))
    print(f"quantized {path} ({total // 1024} KB)", flush=True)


if __name__ == "__main__":
    main()
