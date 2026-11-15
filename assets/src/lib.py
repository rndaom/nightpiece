"""Shared helpers for the Blender asset scripts.

Shapes are authored in *game space*, the same axes the engine uses: x to the
right, y up, and -z the direction a piece faces. Blender is z-up, so every
point passes through `gb()` on its way into a mesh; the glTF exporter's
y-up conversion then lands it back exactly where it was authored.

Vertex colour layout (float RGBA, per face corner), read by the engine's shaders:
    R  module index / 8      which rigid block of the piece this vertex belongs to
    G  glow                  1 on emissive parts (seams, eyes, marks), 0 on stone
    B  edge                  1 on chamfer faces, for edge wear and catch-lights
    A  glow kind             0.25 seam, 0.5 top mark, 1.0 eye; 0 on stone
"""
from __future__ import annotations

import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

COLOR = "Col"
UV_TILE = "UV0"      # box-projected, one unit of surface = one tile
UV_UNIQUE = "UV1"    # non-overlapping, for baked ambient occlusion

GLOW_SEAM = 0.25
GLOW_MARK = 0.5
GLOW_EYE = 1.0


def gb(x: float, y: float, z: float) -> Vector:
    """Game space to Blender space."""
    return Vector((x, -z, y))


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "NONE"


# ---------------------------------------------------------------------------
# Raw solids
# ---------------------------------------------------------------------------

def _mesh_from_bm(bm: bmesh.types.BMesh, name: str) -> bpy.types.Mesh:
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def prism(n: int, w: float, h: float, y: float, top: float | None = None, x: float = 0.0, z: float = 0.0,
          turn: float = 0.0) -> bpy.types.Mesh:
    """An n-sided block, optionally tapered. `w` is the width across flats, `y` its underside."""
    bm = bmesh.new()
    r0 = w / 2 / math.cos(math.pi / n)
    r1 = (w if top is None else top) / 2 / math.cos(math.pi / n)
    lower, upper = [], []
    for i in range(n):
        a = math.pi / n + turn + i * math.tau / n
        lower.append(bm.verts.new(gb(x + math.sin(a) * r0, y, z + math.cos(a) * r0)))
        upper.append(bm.verts.new(gb(x + math.sin(a) * r1, y + h, z + math.cos(a) * r1)))
    bm.faces.new(upper)
    bm.faces.new(lower[::-1])
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([lower[i], lower[j], upper[j], upper[i]])
    return _mesh_from_bm(bm, "prism")


def box(w: float, h: float, d: float, y: float | None = None, cy: float | None = None, x: float = 0.0,
        z: float = 0.0, rot_y: float = 0.0, rot_z: float = 0.0, rot_x: float = 0.0) -> bpy.types.Mesh:
    """A rectangular block: w along x, h along y, d along z. `y` is the underside, or give the centre as `cy`.
    Rotations are in game space, applied about the block's own centre in the order y, z, x."""
    centre_y = cy if cy is not None else (y or 0.0) + h / 2
    bm = bmesh.new()
    corners = []
    rot = (Matrix.Rotation(rot_x, 3, "X") @ Matrix.Rotation(rot_z, 3, "Z") @ Matrix.Rotation(rot_y, 3, "Y"))
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                p = rot @ Vector((sx * w / 2, sy * h / 2, sz * d / 2))
                corners.append(bm.verts.new(gb(x + p.x, centre_y + p.y, z + p.z)))
    v = corners
    for quad in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        bm.faces.new([v[i] for i in quad])
    return _mesh_from_bm(bm, "box")


def cylinder(r: float, a: Vector, b: Vector, segments: int = 28) -> bpy.types.Mesh:
    """A cylinder between two game-space points."""
    axis = (b - a)
    length = axis.length
    zdir = axis.normalized()
    helper = Vector((0, 1, 0)) if abs(zdir.y) < 0.9 else Vector((1, 0, 0))
    xdir = zdir.cross(helper).normalized()
    ydir = zdir.cross(xdir)
    bm = bmesh.new()
    ring0, ring1 = [], []
    for i in range(segments):
        t = i * math.tau / segments
        off = xdir * math.cos(t) * r + ydir * math.sin(t) * r
        p0 = a + off
        p1 = a + off + zdir * length
        ring0.append(bm.verts.new(gb(p0.x, p0.y, p0.z)))
        ring1.append(bm.verts.new(gb(p1.x, p1.y, p1.z)))
    bm.faces.new(ring1)
    bm.faces.new(ring0[::-1])
    for i in range(segments):
        j = (i + 1) % segments
        bm.faces.new([ring0[i], ring0[j], ring1[j], ring1[i]])
    return _mesh_from_bm(bm, "cylinder")


# ---------------------------------------------------------------------------
# Operations on meshes
# ---------------------------------------------------------------------------

def join_raw(meshes: list[bpy.types.Mesh], name: str = "joined") -> bpy.types.Mesh:
    """Append several meshes into one, keeping their attribute layers."""
    bm = bmesh.new()
    for m in meshes:
        bm.from_mesh(m)
    out = bpy.data.meshes.new(name)
    bm.to_mesh(out)
    bm.free()
    for m in meshes:
        bpy.data.meshes.remove(m)
    return out


def _boolean(target: bpy.types.Mesh, others: list[bpy.types.Mesh], operation: str) -> bpy.types.Mesh:
    """Apply one boolean operation per mesh in `others`, using the exact solver. Consumes its inputs."""
    if not others:
        return target
    collection = bpy.context.scene.collection
    a = bpy.data.objects.new("bool_a", target)
    collection.objects.link(a)
    helpers = []
    for c in others:
        b = bpy.data.objects.new("bool_b", c)
        collection.objects.link(b)
        mod = a.modifiers.new("bool", "BOOLEAN")
        mod.operation = operation
        mod.solver = "EXACT"
        mod.object = b
        helpers.append(b)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    result = bpy.data.meshes.new_from_object(a.evaluated_get(depsgraph))
    bpy.data.objects.remove(a)
    bpy.data.meshes.remove(target)
    for b in helpers:
        m = b.data
        bpy.data.objects.remove(b)
        bpy.data.meshes.remove(m)
    return result


def union(meshes: list[bpy.types.Mesh]) -> bpy.types.Mesh:
    """Fuse overlapping solids into one clean shell."""
    return _boolean(meshes[0], meshes[1:], "UNION")


def subtract(target: bpy.types.Mesh, cutters: list[bpy.types.Mesh]) -> bpy.types.Mesh:
    return _boolean(target, cutters, "DIFFERENCE")


def intersect(target: bpy.types.Mesh, other: bpy.types.Mesh) -> bpy.types.Mesh:
    return _boolean(target, [other], "INTERSECT")


def _layers(bm: bmesh.types.BMesh):
    col = bm.loops.layers.float_color.get(COLOR) or bm.loops.layers.float_color.new(COLOR)
    uv0 = bm.loops.layers.uv.get(UV_TILE) or bm.loops.layers.uv.new(UV_TILE)
    uv1 = bm.loops.layers.uv.get(UV_UNIQUE) or bm.loops.layers.uv.new(UV_UNIQUE)
    return col, uv0, uv1


def _box_project(bm: bmesh.types.BMesh, uv_layer, offset: tuple[float, float], scale: float = 1.0,
                 quarter_turns: int = 0) -> None:
    """Planar-project every face along its dominant axis. `scale` is tiles per unit of surface;
    `quarter_turns` rotates the pattern in 90 degree steps so repeated parts do not look identical."""
    for f in bm.faces:
        n = f.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in f.loops:
            p = loop.vert.co
            if az >= ax and az >= ay:
                u, v = p.x, p.y
            elif ay >= ax:
                u, v = p.x, p.z
            else:
                u, v = p.y, p.z
            for _ in range(quarter_turns % 4):
                u, v = -v, u
            loop[uv_layer].uv = (u * scale + offset[0], v * scale + offset[1])


def finish_stone(mesh: bpy.types.Mesh, module: int | callable, bevel: float = 0.014, uv_offset=(0.0, 0.0),
                 sharp_angle: float = 32.0, uv_scale: float = 1.0, uv_turns: int = 0,
                 red: float | None = None) -> bpy.types.Mesh:
    """Chamfer the hard edges of a stone solid and write its vertex colours and tiling UVs.
    `module` is an index, or a function of a face's centre (in game space) returning one.
    `red` overrides the red channel directly, for meshes that use it for something other than modules."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1.0), verts=bm.verts[:], edges=bm.edges[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    col, uv0, _ = _layers(bm)

    bevel_faces: set = set()
    if bevel > 0:
        hard = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > math.radians(sharp_angle)]
        if hard:
            result = bmesh.ops.bevel(bm, geom=hard, offset=bevel, offset_type="OFFSET", segments=1, profile=0.5,
                                     affect="EDGES", clamp_overlap=True)
            bevel_faces = set(result["faces"])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

    for f in bm.faces:
        c = f.calc_center_median()
        m = module(Vector((c.x, c.z, -c.y))) if callable(module) else module
        edge = 1.0 if f in bevel_faces else 0.0
        for loop in f.loops:
            loop[col] = (m / 8.0 if red is None else red, 0.0, edge, 0.0)
    _box_project(bm, uv0, uv_offset, uv_scale, uv_turns)
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def finish_glow(mesh: bpy.types.Mesh, module: int | callable, kind: float) -> bpy.types.Mesh:
    """Write vertex colours for an emissive part. `module` may be a function of a vertex position
    (game space), so that a seam can stretch between the two blocks it joins."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    col, uv0, _ = _layers(bm)
    for f in bm.faces:
        for loop in f.loops:
            p = loop.vert.co
            m = module(Vector((p.x, p.z, -p.y))) if callable(module) else module
            loop[col] = (m / 8.0, 1.0, 0.0, kind)
    _box_project(bm, uv0, (0.0, 0.0))
    bm.to_mesh(mesh)
    bm.free()
    return mesh


def text_mesh(body: str, font: bpy.types.VectorFont, size: float, depth: float) -> bpy.types.Mesh:
    """A flat extruded glyph centred on the origin, lying on Blender's XY plane with its top at z = depth."""
    curve = bpy.data.curves.new("glyph", "FONT")
    curve.body = body
    curve.font = font
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = depth / 2
    curve.resolution_u = 2                  # coarse curves: these glyphs are a fifth of a square tall
    obj = bpy.data.objects.new("glyph", curve)
    bpy.context.scene.collection.objects.link(obj)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    bpy.data.objects.remove(obj)
    bpy.data.curves.remove(curve)
    for v in mesh.vertices:
        v.co.z += depth / 2
    return mesh


def transform(mesh: bpy.types.Mesh, matrix: Matrix) -> bpy.types.Mesh:
    mesh.transform(matrix)
    return mesh


def make_object(mesh: bpy.types.Mesh, name: str) -> bpy.types.Object:
    mesh.name = name
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    # Smooth shading across shallow angles only (the round pieces), hard everywhere else.
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.set_sharp_from_angle(angle=math.radians(32.0))
    mesh.color_attributes.active_color = mesh.color_attributes[COLOR]
    mesh.color_attributes.render_color_index = mesh.color_attributes.find(COLOR)
    return obj


def unwrap_unique(obj: bpy.types.Object, cell: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 1.0)) -> None:
    """Fill UV1 with a non-overlapping unwrap, then squeeze it into `cell` (u0, v0, u1, v1) of an atlas."""
    mesh = obj.data
    mesh.uv_layers.active = mesh.uv_layers[UV_UNIQUE]
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60.0), island_margin=0.012, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    u0, v0, u1, v1 = cell
    pad = 0.012
    layer = mesh.uv_layers[UV_UNIQUE].data
    for d in layer:
        d.uv = (u0 + (pad + d.uv[0] * (1 - 2 * pad)) * (u1 - u0), v0 + (pad + d.uv[1] * (1 - 2 * pad)) * (v1 - v0))
    mesh.uv_layers.active = mesh.uv_layers[UV_TILE]


# ---------------------------------------------------------------------------
# Baking and export
# ---------------------------------------------------------------------------

def setup_cycles(samples: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.threads_mode = "AUTO"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    scene.world.light_settings.distance = 0.9


def bake_ao(objects: list[bpy.types.Object], image: bpy.types.Image, floor_y: float | None = 0.0,
            margin: int = 6, together: bool = False, distance: float = 0.9) -> None:
    """Bake ambient occlusion into a shared atlas image. By default each object is baked alone
    (plus an optional floor); with `together` they occlude one another, as parts of one scene."""
    scene = bpy.context.scene
    scene.world.light_settings.distance = distance
    material = bpy.data.materials.new("bake")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    nodes.active = tex

    floor = None
    if floor_y is not None:
        floor = bpy.data.objects.new("bake_floor", box(40, 0.2, 40, y=floor_y - 0.2))
        scene.collection.objects.link(floor)

    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)
    first = True
    for obj in objects:
        for other in objects:
            other.hide_render = (other is not obj) and not together
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="AO", margin=margin, use_clear=first, uv_layer=UV_UNIQUE)
        first = False
        print(f"baked ambient occlusion: {obj.name}", flush=True)

    for obj in objects:
        obj.hide_render = False
        obj.data.materials.clear()
    if floor is not None:
        m = floor.data
        bpy.data.objects.remove(floor)
        bpy.data.meshes.remove(m)
    bpy.data.materials.remove(material)


def save_grey_jpeg(image: bpy.types.Image, path: str, quality: int = 92) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    image.filepath_raw = path
    image.file_format = "JPEG"
    image.save(quality=quality)


def bake_light(objects: list[bpy.types.Object], image: bpy.types.Image, direct: bool = True, indirect: bool = True,
               margin: int = 8, albedo: float = 0.5, label: str = "light") -> None:
    """Bake the diffuse light that falls on `objects` into a shared atlas image (UV1), without their
    own colour. Whatever lamps and glowing meshes are shown for rendering at the time are the light;
    every object in the scene shades and bounces it. `albedo` is how much of it the baked surfaces
    pass on at each bounce."""
    material = bpy.data.materials.new("bake_light")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    shader = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (albedo, albedo, albedo, 1.0)
    shader.inputs["Roughness"].default_value = 1.0
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    nodes.active = tex
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)
    passes = {p for p, on in (("DIRECT", direct), ("INDIRECT", indirect)) if on}
    for i, obj in enumerate(objects):
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="DIFFUSE", pass_filter=passes, margin=margin, use_clear=(i == 0), uv_layer=UV_UNIQUE)
    print(f"baked {label}", flush=True)
    for obj in objects:
        obj.data.materials.clear()
    bpy.data.materials.remove(material)


def image_pixels(image: bpy.types.Image):
    """An image's pixels as a float array of shape (height, width, 4), rows bottom to top as Blender keeps them."""
    import numpy as np
    w, h = image.size
    data = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(data)
    return data.reshape(h, w, 4)


def save_rgb_jpeg(rgb, path: str, quality: int = 93) -> None:
    """Write a float array of shape (height, width, 3), rows bottom to top, values 0..1, as a JPEG
    with the stored values untouched (no colour management).

    The three channels may hold unrelated things. Pillow, where this Python has it, keeps them
    apart at full resolution; Blender's own writer halves the resolution of the differences
    between them, which lets fine detail in one channel show faintly in the others."""
    import numpy as np
    os.makedirs(os.path.dirname(path), exist_ok=True)
    h, w, _ = rgb.shape
    try:
        from PIL import Image
    except ImportError:
        Image = None
    if Image is not None:
        data = (np.clip(rgb[::-1], 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        Image.fromarray(data, "RGB").save(path, quality=quality, subsampling=0)
        return
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[..., :3] = np.clip(rgb, 0.0, 1.0)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "JPEG"
    img.save(quality=quality)
    bpy.data.images.remove(img)


def export_glb(objects: list[bpy.types.Object], path: str) -> None:
    """Geometry only: positions, normals, both UV sets, vertex colours and custom properties.
    Materials are built in the engine, where they need custom shader hooks."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_active_vertex_color_when_no_material=True,
        export_all_vertex_colors=False,
        export_extras=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"exported {path} ({os.path.getsize(path) / 1024:.0f} KB)", flush=True)
