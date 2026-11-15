"""Build and rig the puppeteer's hand.

    blender -b --factory-startup -P assets/src/hands.py -- --out public/assets [--preview some/folder]

Writes <out>/hand.glb: one right hand with its forearm, skinned to a 17-bone
skeleton, plus the plumb weight that hangs from the cord at its wrist. The
forearm is as wide as an arm is for the whole of its length, and wider toward
the elbow; it has no modelled end to be seen, because the hand's material
thins it away to nothing before it gets there (src/hands/material.ts). The
engine mirrors it for left hands and poses the fingers itself (grips are
fitted to each piece at run time), so no animation is baked here.

The hand is authored in its own space, in game axes: the wrist is the origin,
the fingers point along -z, the back of the hand faces +y, and the thumb is
on the -x side. One unit is one square of the board; the hand is 3.7 squares
from wrist to fingertip (style bible, section 5).

The skin is one closed surface. It is not modelled by hand: the hand is
described as a field (how far any point is from the surface, negative
inside), built from tapered bones, pads of flesh and knuckles that melt into
each other, and the skin is the surface where that field is zero. That gives
webbing between the fingers, knuckles that are form and not drawn lines, and
normals taken from the field itself, which are smooth however coarse the
mesh. The hand's material depends on that: its edge light and its drawn line
both follow the normals.

Vertex colour layout for the hand (float RGBA), read by the hand shader:
    R  digit      0 on the palm and forearm; on a finger or the thumb, 0 at its knuckle rising to 1 at its tip
    G  reach      how far along the whole limb: 0 at the far end of the forearm, 1 at the tip of the middle finger
    B  turn       how tightly the skin curves there, as 1/16 of one over the radius of the curve: 0 where it
                  is flat or hollow, about 0.5 round a finger, 1 at the very tip of one. The shader uses it to
                  tell how far a point is from the hand's edge as seen, so that the light inside hugs the edge
    A  cord       1 on the cord at the wrist, 0 on skin
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
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib  # noqa: E402
from lib import COLOR, gb  # noqa: E402

V = Vector
UP = V((0.0, 1.0, 0.0))

# Wrist to the far end of the forearm.
FOREARM_LENGTH = 3.4
# The size of the cells the skin is cut from. Fingers come out about eighteen faces round.
CELL = 0.06
# Past this point the forearm is cut from longer cells: it is a plain tube from there on.
STRETCH_FROM, STRETCH = 0.55, 2.4
CORD_RADIUS = 0.0135
# The data channel holds how tightly the skin curves as a fraction of this (one over a radius, in squares).
TURN_SCALE = 16.0


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def direction(yaw_deg: float, pitch_deg: float = 0.0) -> Vector:
    """A unit vector pointing forward (-z), turned `yaw` degrees toward +x and tipped `pitch` degrees up."""
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    return V((math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)))


def arr(v) -> np.ndarray:
    return np.array([v[0], v[1], v[2]], dtype=np.float64)


def length(v: np.ndarray) -> np.ndarray:
    return np.sqrt((v * v).sum(-1))


# ---------------------------------------------------------------------------
# The skeleton
# ---------------------------------------------------------------------------

class Finger:
    """A chain of three bones. `joints` are the knuckle, the two finger joints and the tip."""

    def __init__(self, name: str, origin: Vector, lengths: tuple[float, float, float],
                 headings: tuple[tuple[float, float], ...], radii: tuple[float, float, float, float],
                 back: Vector, blend: float):
        self.name = name
        self.joints = [origin.copy()]
        for bone_length, (yaw, pitch) in zip(lengths, headings):
            self.joints.append(self.joints[-1] + direction(yaw, pitch) * bone_length)
        self.lengths = lengths
        self.radii = radii                 # at the knuckle, the two joints and the tip
        self.back = back.normalized()      # which way the nail faces
        self.blend = blend                 # half the stretch of skin over which the knuckle's bend is shared out
        self.total = sum(lengths)
        self.bones = [f"{name}{i + 1}" for i in range(3)]
        self.edges = [0.0, lengths[0], lengths[0] + lengths[1], self.total]

        # The same chain as arrays, for the field. The centre line starts inside the palm and stops
        # short of the tip, so that the rounded end of the last bone finishes where the bone does.
        self.tip_radius = radii[3]
        j = [arr(p) for p in self.joints]
        first = (j[1] - j[0]) / lengths[0]
        last = (j[3] - j[2]) / lengths[2]
        self.seg_a = [j[0] - first * 0.5, j[1], j[2]]
        self.seg_b = [j[1], j[2], j[3] - last * (self.tip_radius * 0.92)]
        self.seg_s = [-0.5, self.edges[1], self.edges[2]]
        self.frames = []
        nail = arr(self.back)
        for a, b in zip(self.seg_a, self.seg_b):
            forward = (b - a) / np.linalg.norm(b - a)
            back_ = nail - forward * nail.dot(forward)
            back_ /= np.linalg.norm(back_)
            self.frames.append((forward, back_, np.cross(back_, forward)))

    def radius(self, s: np.ndarray) -> np.ndarray:
        """How thick the finger is at arc length `s` from its knuckle: a taper that draws in to the tip."""
        e = self.edges
        r = np.interp(s, [e[0], e[1], e[2], e[3]], self.radii)
        return r * (1 - 0.2 * smoothstep(e[3] - 0.34, e[3] - 0.03, s))

    def locate(self, p: np.ndarray):
        """For each point: its arc length along the finger (negative behind the knuckle), how far it is
        from the finger's skin (negative inside), and how much it faces the back of the finger (-1 to 1)."""
        e = self.edges
        best = None
        for (a, b, s0), (forward, back_, right) in zip(zip(self.seg_a, self.seg_b, self.seg_s), self.frames):
            ab = b - a
            span = np.linalg.norm(ab)
            t = np.clip(((p - a) @ ab) / (span * span), 0.0, 1.0)
            v = p - (a + t[:, None] * ab)
            s = s0 + t * span
            at_first = np.exp(-((s - e[1]) / 0.085) ** 2)
            at_second = np.exp(-((s - e[2]) / 0.07) ** 2)
            # The joints are bone: proud on the back of the finger and wide across it, not swollen all
            # round. Underneath, each bone carries a pad, fullest on the last.
            proud = 0.024 * at_first + 0.013 * at_second
            pads = (0.010 * np.exp(-((s - (e[0] + e[1]) / 2) / (0.3 * (e[1] - e[0]))) ** 2)
                    + 0.008 * np.exp(-((s - (e[1] + e[2]) / 2) / (0.3 * (e[2] - e[1]))) ** 2)
                    + 0.016 * smoothstep(e[2] + 0.04, e[3] - 0.12, s))
            wide = 1 + 0.085 * at_first + 0.05 * at_second
            # A little wider than deep, more so toward the tip.
            flat = 0.95 - 0.08 * smoothstep(e[2] - 0.1, e[3], s)
            vb = v @ back_ - proud + pads
            vr = (v @ right) / wide
            vf = v @ forward
            d = np.sqrt(vr * vr + (vb / flat) ** 2 + vf * vf)
            r = self.radius(s)
            dist = d - r
            # The nail: the back of the last bone is planed flat from its middle to the tip.
            nail = smoothstep(e[2] + 0.22 * self.lengths[2], e[2] + 0.5 * self.lengths[2], s)
            dist = carve(dist, vb / flat - r * (1.9 - 1.07 * nail), 0.018)
            facing = vb / np.maximum(d * flat, 1e-9)
            if best is None:
                best = [s, dist, facing, d]
            else:
                nearer = d < best[3]
                for i, value in enumerate((s, dist, facing, d)):
                    best[i] = np.where(nearer, value, best[i])
        return best[0], best[1], best[2]

    def frame(self, s: float) -> tuple[Vector, Vector, Vector, Vector]:
        """Centre line point and a (forward, back, right) frame at arc length `s` from the knuckle."""
        i = 0 if s < self.edges[1] else 1 if s < self.edges[2] else 2
        a, b = self.joints[i], self.joints[i + 1]
        forward = (b - a).normalized()
        back = (self.back - forward * self.back.dot(forward)).normalized()
        return a + forward * (s - self.edges[i]), forward, back, back.cross(forward).normalized()

    def weights(self, s: np.ndarray) -> dict[str, np.ndarray]:
        """Skin weights at arc length `s`: each joint shares its bend between the two bones that meet at it."""
        h = 0.105
        a = [smoothstep(self.edges[0] - self.blend, self.edges[0] + self.blend, s),
             smoothstep(self.edges[1] - h, self.edges[1] + h, s),
             smoothstep(self.edges[2] - h, self.edges[2] + h, s)]
        return {"hand": 1 - a[0], self.bones[0]: a[0] - a[1], self.bones[1]: a[1] - a[2], self.bones[2]: a[2]}


def build_fingers() -> dict[str, Finger]:
    # Long, tapering fingers with strong joints (style bible, 6.1). The bones are where they have
    # always been: grips, poses and the tests on them all hang off this skeleton.
    return {
        "index": Finger("index", V((-0.56, 0.02, -1.90)), (0.67, 0.46, 0.39), ((-6, 0), (-6, 0), (-6, 0)),
                        (0.152, 0.133, 0.118, 0.101), UP, 0.105),
        "middle": Finger("middle", V((-0.16, 0.04, -1.98)), (0.76, 0.52, 0.44), ((-1, 0), (-1, 0), (-1, 0)),
                         (0.156, 0.136, 0.121, 0.103), UP, 0.105),
        "ring": Finger("ring", V((0.24, 0.02, -1.88)), (0.70, 0.47, 0.41), ((5, 0), (5, 0), (5, 0)),
                       (0.147, 0.128, 0.114, 0.098), UP, 0.105),
        "little": Finger("little", V((0.60, -0.02, -1.68)), (0.54, 0.36, 0.32), ((13, 0), (13, 0), (13, 0)),
                         (0.129, 0.112, 0.100, 0.087), UP, 0.105),
        # The thumb's nail faces up and outward, so that its own bend closes it toward the fingers.
        "thumb": Finger("thumb", V((-0.50, -0.06, -0.40)), (0.88, 0.66, 0.56), ((-38, -7), (-30, -4), (-26, -2)),
                        (0.196, 0.172, 0.153, 0.131), V((-0.78, 0.62, 0.0)), 0.25),
    }


# ---------------------------------------------------------------------------
# The field
# ---------------------------------------------------------------------------

def melt(a: np.ndarray, b: np.ndarray, k: float) -> np.ndarray:
    """The union of two shapes, with the crease where they meet filled in to a radius of about `k`."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1 - h)


def carve(a: np.ndarray, b: np.ndarray, k: float) -> np.ndarray:
    """The part of shape `a` that is also inside `b`, with a soft edge."""
    return -melt(-a, -b, k)


def ellipsoid(p: np.ndarray, centre, radii, yaw_deg: float = 0.0) -> np.ndarray:
    q = p - arr(centre)
    yaw = math.radians(yaw_deg)
    c, s = math.cos(yaw), math.sin(yaw)
    # Into the ellipsoid's own frame: its long axis points forward, turned `yaw` toward +x.
    x = q[:, 0] * c + q[:, 2] * s
    z = -q[:, 0] * s + q[:, 2] * c
    q = np.stack([x, q[:, 1], z], axis=1)
    r = arr(radii)
    k0 = length(q / r)
    k1 = length(q / (r * r))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def bone(p: np.ndarray, a, b, ra: float, rb: float, flat: float = 1.0) -> np.ndarray:
    """A tapered, round-ended bone from `a` to `b`, squashed to `flat` of its depth front to back."""
    a, b = arr(a), arr(b)
    ab = b - a
    t = np.clip(((p - a) @ ab) / ab.dot(ab), 0.0, 1.0)
    v = p - (a + t[:, None] * ab)
    return np.sqrt(v[:, 0] ** 2 + (v[:, 1] / flat) ** 2 + v[:, 2] ** 2) - (ra + (rb - ra) * t)


def slab(p: np.ndarray, centre, half, corner: float) -> np.ndarray:
    q = np.abs(p - arr(centre)) - arr(half) + corner
    return length(np.maximum(q, 0.0)) + np.minimum(q.max(axis=1), 0.0) - corner


# The wrist and forearm: a rounded tube whose section changes along its length. It is narrowest at
# the wrist, and widens and deepens from there toward the elbow, as an arm does; it never narrows again.
ARM_Z = [-0.75, -0.36, 0.0, 0.30, 0.62, 1.20, 2.00, 2.80, FOREARM_LENGTH]
ARM_HALF_WIDTH = [0.36, 0.44, 0.47, 0.465, 0.49, 0.535, 0.59, 0.635, 0.66]
ARM_HALF_DEPTH = [0.07, 0.165, 0.255, 0.28, 0.31, 0.365, 0.43, 0.48, 0.51]
ARM_POWER = 2.35


def arm_section(z):
    return np.interp(z, ARM_Z, ARM_HALF_WIDTH), np.interp(z, ARM_Z, ARM_HALF_DEPTH)


def arm(p: np.ndarray) -> np.ndarray:
    hw, hd = arm_section(p[:, 2])
    k = (np.abs(p[:, 0] / hw) ** ARM_POWER + np.abs(p[:, 1] / hd) ** ARM_POWER) ** (1 / ARM_POWER)
    return carve((k - 1.0) * hd, np.maximum(ARM_Z[0] - p[:, 2], p[:, 2] - FOREARM_LENGTH), 0.04)


class HandField:
    def __init__(self, fingers: dict[str, Finger]):
        self.fingers = fingers

    def body(self, p: np.ndarray) -> np.ndarray:
        """Everything but the digits: palm, heels, knuckles, wrist and forearm."""
        f = self.fingers
        # The bones of the palm, fanning from the wrist to each knuckle. They leave faint ridges on
        # the back of the hand, which is all the drawing the tendons need.
        roots = {"index": (-0.27, 0.0, -0.24), "middle": (-0.07, 0.015, -0.24), "ring": (0.13, 0.0, -0.24), "little": (0.31, -0.02, -0.22)}
        d = None
        for name, root in roots.items():
            knuckle = arr(f[name].joints[0])
            ray = bone(p, root, knuckle, 0.215, f[name].radii[0] * 1.1, 0.84)
            d = ray if d is None else melt(d, ray, 0.13)
        # Flesh on the palm side: the middle of the palm, the pad below the fingers, the two heels.
        d = melt(d, slab(p, (0.02, -0.035, -1.02), (0.5, 0.115, 0.82), 0.11), 0.12)
        d = melt(d, ellipsoid(p, (0.03, -0.085, -1.66), (0.63, 0.135, 0.24)), 0.1)
        d = melt(d, ellipsoid(p, (-0.47, -0.14, -0.80), (0.33, 0.235, 0.5), -27), 0.12)
        d = melt(d, ellipsoid(p, (0.43, -0.10, -0.80), (0.275, 0.215, 0.66), 4), 0.12)
        # The knuckles, proud of the back of the hand.
        for name in roots:
            head = arr(f[name].joints[0]) + np.array([0.0, 0.035, 0.03])
            d = melt(d, length(p - head) - f[name].radii[0] * 1.12, 0.07)
        # The thumb's first bone lies inside the hand; this is the flesh over it, and the web that
        # runs from it to the first finger.
        t = f["thumb"]
        d = melt(d, bone(p, arr(t.joints[0]) - t.frames[0][0] * 0.3, arr(t.joints[1]) + t.frames[0][0] * 0.05, 0.25, 0.185), 0.16)
        d = melt(d, ellipsoid(p, (-0.71, -0.095, -1.13), (0.25, 0.105, 0.43), -14), 0.13)
        d = melt(d, arm(p), 0.16)
        # The small bone that stands out at the wrist on the little finger's side.
        d = melt(d, length(p - np.array([0.35, 0.17, 0.05])) - 0.1, 0.12)
        return d

    def __call__(self, p: np.ndarray) -> np.ndarray:
        d = self.body(p)
        digits = None
        for finger in self.fingers.values():
            _, dist, _ = finger.locate(p)
            # Fingers never melt into each other, only into the hand, or they would grow webs to their tips.
            digits = dist if digits is None else np.minimum(digits, dist)
        return melt(d, digits, 0.075)

    def normal(self, p: np.ndarray) -> np.ndarray:
        h = 2e-3
        g = np.empty_like(p)
        for axis in range(3):
            step = np.zeros(3)
            step[axis] = h
            g[:, axis] = self(p + step) - self(p - step)
        return g / np.maximum(length(g)[:, None], 1e-12)

    def turn(self, p: np.ndarray, h: float = 0.03) -> np.ndarray:
        """How tightly the surface curves at each point, the tighter of the two ways it can: one over the
        radius of the curve, and nothing where the surface is flat or hollow."""
        n = self.normal(p)
        change = np.empty((len(p), 3, 3))
        for axis in range(3):
            step = np.zeros(3)
            step[axis] = h
            change[:, :, axis] = (self.normal(p + step) - self.normal(p - step)) / (2 * h)
        # How the normal changes as one moves over the surface: only the part that lies in the surface counts.
        flat = np.eye(3)[None, :, :] - n[:, :, None] * n[:, None, :]
        shape = flat @ (0.5 * (change + change.transpose(0, 2, 1))) @ flat
        return np.maximum(np.linalg.eigvalsh(shape)[:, 2], 0.0)

    def settle(self, p: np.ndarray, rounds: int = 3) -> np.ndarray:
        """Move points onto the surface, along the field's own slope."""
        for _ in range(rounds):
            p = p - self.normal(p) * self(p)[:, None]
        return p


# ---------------------------------------------------------------------------
# From the field to a skin
# ---------------------------------------------------------------------------

def unstretch(u: np.ndarray) -> np.ndarray:
    """From the space the cells are laid out in to hand space: the far forearm is cut from longer cells."""
    p = u.copy()
    far = u[:, 2] > STRETCH_FROM
    p[far, 2] = STRETCH_FROM + (u[far, 2] - STRETCH_FROM) * STRETCH
    return p


def cut_skin(field: HandField) -> tuple[np.ndarray, np.ndarray]:
    """The surface where the field is zero, as points and four-sided faces (surface nets: one point in
    every cell the surface passes through, one face across every cell edge it crosses)."""
    lo = np.array([-2.0, -0.8, -3.9])
    hi = np.array([1.1, 0.8, STRETCH_FROM + (FOREARM_LENGTH - STRETCH_FROM) / STRETCH + 0.15])
    n = np.ceil((hi - lo) / CELL).astype(int) + 1
    grid = np.stack(np.meshgrid(*(np.arange(k) for k in n), indexing="ij"), axis=-1).reshape(-1, 3)
    values = field(unstretch(lo + grid * CELL)).reshape(n)
    inside = values < 0

    corners = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    count = np.zeros([m - 1 for m in n], dtype=np.int8)
    for c in corners:
        count += inside[tuple(slice(c[a], n[a] - 1 + c[a]) for a in range(3))]
    crossed = (count > 0) & (count < 8)
    index = -np.ones(crossed.shape, dtype=np.int64)
    cells = np.argwhere(crossed)
    index[crossed] = np.arange(len(cells))

    # Each point starts at the mean of where the surface crosses its cell's edges.
    total = np.zeros((len(cells), 3))
    hits = np.zeros(len(cells))
    for a in range(8):
        for b in range(a + 1, 8):
            if sum(abs(corners[a][k] - corners[b][k]) for k in range(3)) != 1:
                continue
            ca, cb = cells + corners[a], cells + corners[b]
            fa, fb = values[ca[:, 0], ca[:, 1], ca[:, 2]], values[cb[:, 0], cb[:, 1], cb[:, 2]]
            cross = (fa < 0) != (fb < 0)
            t = np.where(cross, fa / np.where(cross, fa - fb, 1.0), 0.0)
            total += np.where(cross[:, None], ca + (cb - ca) * t[:, None], 0.0)
            hits += cross
    points = unstretch(lo + total / hits[:, None] * CELL)

    faces = []
    for axis in range(3):
        u, v = (axis + 1) % 3, (axis + 2) % 3
        # Every edge along this axis that runs from inside to outside, or the other way.
        shape = list(n)
        shape[axis] -= 1
        a = inside[tuple(slice(0, shape[k]) for k in range(3))]
        b = inside[tuple(slice(1, None) if k == axis else slice(None) for k in range(3))]
        for edge in np.argwhere(a != b):
            if edge[u] == 0 or edge[v] == 0 or edge[u] >= n[u] - 1 or edge[v] >= n[v] - 1:
                continue
            ring = []
            for du, dv in ((-1, -1), (0, -1), (0, 0), (-1, 0)):
                c = edge.copy()
                c[u] += du
                c[v] += dv
                ring.append(index[c[0], c[1], c[2]])
            faces.append(ring if a[tuple(edge)] else ring[::-1])
    return points, np.array(faces, dtype=np.int64)


def even_out(field: HandField, points: np.ndarray, faces: np.ndarray, rounds: int = 14) -> np.ndarray:
    """Slide every point toward the middle of its neighbours, keeping it on the surface, so that the
    faces come out even: the drawn line is only as steady as the mesh under it."""
    edges = np.concatenate([faces[:, [i, (i + 1) % 4]] for i in range(4)])
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    degree = np.zeros(len(points))
    np.add.at(degree, edges[:, 0], 1)
    np.add.at(degree, edges[:, 1], 1)
    for _ in range(rounds):
        mean = np.zeros_like(points)
        np.add.at(mean, edges[:, 0], points[edges[:, 1]])
        np.add.at(mean, edges[:, 1], points[edges[:, 0]])
        mean /= degree[:, None]
        normal = field.normal(points)
        move = mean - points
        move -= normal * (move * normal).sum(-1)[:, None]
        points = field.settle(points + move * 0.55, 2)
    return field.settle(points, 3)


def spread_over(values: np.ndarray, faces: np.ndarray, rounds: int) -> np.ndarray:
    """Average a number held at each point of a mesh with its neighbours', a few times over."""
    edges = np.concatenate([faces[:, [k, (k + 1) % faces.shape[1]]] for k in range(faces.shape[1])])
    edges = np.concatenate([edges, edges[:, ::-1]])
    degree = np.bincount(edges[:, 0], minlength=len(values)).astype(float)
    for _ in range(rounds):
        around = np.bincount(edges[:, 0], weights=values[edges[:, 1]], minlength=len(values)) / np.maximum(degree, 1.0)
        values = 0.5 * values + 0.5 * around
    return values


def skin_of(field: HandField, points: np.ndarray, faces: np.ndarray, fingers: dict[str, Finger]) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Skin weights and the data channel for points on the hand's surface, from where each one is."""
    count = len(points)
    z = points[:, 2]
    forearm = smoothstep(-0.20, 0.42, z)
    weights: dict[str, np.ndarray] = {"hand": np.zeros(count), "forearm": np.zeros(count)}
    belong = {}
    for name, f in fingers.items():
        s, dist, facing = f.locate(points)
        # How much of this point is the finger's: all of it on the finger's own skin, none a little way off.
        # The thumb's first bone carries the whole heel of the thumb with it, so its reach is wider there.
        reach = 0.16 if name != "thumb" else 0.16 + 0.27 * (1 - smoothstep(0.55, 0.95, s))
        belong[name] = ((1 - smoothstep(0.02, reach, dist)) * smoothstep(-0.45, -0.2, s), s, facing)
    share = sum(b[0] for b in belong.values())
    scale = 1.0 / np.maximum(1.0, share)
    rest = 1.0 - np.minimum(1.0, share)

    digit = np.zeros(count)
    distance = rest * -z
    for name, f in fingers.items():
        m, s, _ = belong[name]
        m = m * scale
        for group, w in f.weights(s).items():
            weights[group] = weights.get(group, np.zeros(count)) + m * w
        digit += m * np.clip(s / f.total, 0.0, 1.0)
        distance += m * (-f.joints[0].z + np.maximum(s, -0.3))
    # Whatever the fingers do not claim belongs to the hand, or past the wrist to the forearm. The
    # fingers' own share of "hand" (behind each knuckle) is split the same way.
    weights["forearm"] = (rest + weights["hand"]) * forearm
    weights["hand"] = (rest + weights["hand"]) * (1 - forearm)

    reach_ = np.clip((distance + FOREARM_LENGTH) / (-fingers["middle"].joints[3].z + FOREARM_LENGTH), 0.0, 1.0)
    # Averaged over a wide patch: what the shader needs to know is how round the whole form is there,
    # and the rounded edge of a flat palm is not a finger.
    turn = np.clip(spread_over(field.turn(points), faces, 28) / TURN_SCALE, 0.0, 1.0)
    data = np.stack([digit, reach_, turn, np.zeros(count)], axis=1)
    return weights, data


def cord_path(field: HandField) -> list[np.ndarray]:
    """The centre line of a cord wound three times round the wrist, lying on the skin."""
    turns, per_turn = 3.0, 34
    steps = int(turns * per_turn) + 1
    path = []
    for i in range(steps):
        k = i / (steps - 1)
        angle = k * turns * math.tau + 2.2
        # Wound by hand: the turns are not quite parallel, and they close up toward the knot.
        z = 0.185 + 0.20 * k + 0.012 * math.sin(angle * 0.5 + 0.8) + 0.008 * math.sin(k * 23.0)
        out = np.array([math.sin(angle), math.cos(angle), 0.0])
        lo, hi = 0.1, 0.9
        for _ in range(26):
            mid = (lo + hi) / 2
            if field((out * mid + np.array([0.0, 0.0, z]))[None, :])[0] < CORD_RADIUS * 0.75:
                lo = mid
            else:
                hi = mid
        path.append(out * lo + np.array([0.0, 0.0, z]))
    return path


def add_cord(bm: bmesh.types.BMesh, path: list[np.ndarray], knot: np.ndarray) -> list:
    """The cord as a thin tube with tapered ends, and the knot the plumb line hangs from. Returns its vertices."""
    made = []
    sides = 6
    rows = []
    for i, c in enumerate(path):
        tangent = path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]
        tangent /= np.linalg.norm(tangent)
        out = np.array([c[0], c[1], 0.0])
        out /= np.linalg.norm(out)
        side = np.cross(tangent, out)
        side /= np.linalg.norm(side)
        out = np.cross(side, tangent)
        ends = min(i, len(path) - 1 - i) / 5.0
        r = CORD_RADIUS * (0.25 + 0.75 * min(1.0, ends))
        row = []
        for k in range(sides):
            a = k * math.tau / sides
            row.append(bm.verts.new(gb(*(c + out * (r * math.cos(a)) + side * (r * math.sin(a))))))
        rows.append(row)
        made += row
    for a, b in zip(rows, rows[1:]):
        for k in range(sides):
            j = (k + 1) % sides
            bm.faces.new([a[k], a[j], b[j], b[k]])
    bm.faces.new(rows[0][::-1])
    bm.faces.new(rows[-1])
    # The knot: a small faceted bead.
    top = bm.verts.new(gb(*(knot + np.array([0.0, 0.034, 0.0]))))
    bottom = bm.verts.new(gb(*(knot - np.array([0.0, 0.04, 0.0]))))
    ring = [bm.verts.new(gb(*(knot + np.array([0.03 * math.cos(k * math.tau / 6), 0.0, 0.03 * math.sin(k * math.tau / 6)]))))
            for k in range(6)]
    for k in range(6):
        j = (k + 1) % 6
        bm.faces.new([top, ring[j], ring[k]])
        bm.faces.new([bottom, ring[k], ring[j]])
    return made + [top, bottom] + ring


def build_hand(fingers: dict[str, Finger]) -> tuple[bpy.types.Object, np.ndarray]:
    field = HandField(fingers)
    points, faces = cut_skin(field)
    points = even_out(field, points, faces)
    normals = field.normal(points)
    weights, data = skin_of(field, points, faces, fingers)

    bm = bmesh.new()
    verts = [bm.verts.new(gb(*p)) for p in points]
    for face in faces:
        bm.faces.new([verts[i] for i in face])

    path = cord_path(field)
    # The plumb line hangs from under the wrist, on the little finger's side.
    knot = min(path[len(path) // 3: 2 * len(path) // 3], key=lambda c: (c[0] - 0.27) ** 2 + (c[1] + 0.3) ** 2).copy()
    knot_out = np.array([knot[0], knot[1], 0.0])
    knot = knot + knot_out / np.linalg.norm(knot_out) * 0.02
    cord = add_cord(bm, path, knot)
    cord_points = np.array([[v.co.x, v.co.z, -v.co.y] for v in cord])            # Blender back to hand space
    cord_forearm = smoothstep(-0.20, 0.42, cord_points[:, 2])
    cord_normals = cord_points - np.array([[0.0, 0.0, 1.0]]) * cord_points[:, 2:3]
    cord_normals /= np.maximum(length(cord_normals)[:, None], 1e-9)

    bm.verts.index_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    col = bm.loops.layers.float_color.new(COLOR)
    skin_count = len(points)
    data = np.concatenate([data, np.tile([0.0, 0.5, 1.0, 1.0], (len(cord), 1))])
    for face in bm.faces:
        for loop in face.loops:
            loop[col] = tuple(data[loop.vert.index])
    mesh = bpy.data.meshes.new("hand_skin")
    bm.to_mesh(mesh)
    bm.free()

    for poly in mesh.polygons:
        poly.use_smooth = True
    # The skin's normals come from the field, not from the faces: they are exact, so the light that
    # hugs the hand's edge is smooth however few faces a finger has.
    all_normals = np.concatenate([normals, cord_normals])
    mesh.normals_split_custom_set_from_vertices([tuple(gb(*n)) for n in all_normals])

    obj = bpy.data.objects.new("hand_skin", mesh)
    bpy.context.scene.collection.objects.link(obj)
    mesh.color_attributes.active_color = mesh.color_attributes[COLOR]
    mesh.color_attributes.render_color_index = mesh.color_attributes.find(COLOR)

    names = ["hand", "forearm"] + [b for f in fingers.values() for b in f.bones]
    groups = {name: obj.vertex_groups.new(name=name) for name in names}
    for name in names:
        w = weights[name]
        for i in np.nonzero(w > 1e-4)[0]:
            groups[name].add([int(i)], float(w[i]), "REPLACE")
    for k in range(len(cord)):
        i = skin_count + k
        groups["forearm"].add([i], float(cord_forearm[k]), "REPLACE")
        groups["hand"].add([i], float(1 - cord_forearm[k]), "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    # Each vertex follows at most four bones, which is what the engine's skinning reads.
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    return obj, knot


def build_armature(fingers: dict[str, Finger]) -> bpy.types.Object:
    data = bpy.data.armatures.new("hand_rig")
    rig = bpy.data.objects.new("hand_rig", data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")

    def add(name: str, head: Vector, tail: Vector, parent, back: Vector, connected: bool = False):
        b = data.edit_bones.new(name)
        b.head = gb(*head)
        b.tail = gb(*tail)
        b.align_roll(gb(*back))              # the bone's own z axis points out of the back of the hand
        b.parent = parent
        b.use_connect = connected
        return b

    hand = add("hand", V((0, 0, 0)), V((0, 0, -1.0)), None, UP)
    add("forearm", V((0, 0, 0)), V((0, 0, 2.0)), hand, UP)
    for f in fingers.values():
        parent = hand
        for i, name in enumerate(f.bones):
            parent = add(name, f.joints[i], f.joints[i + 1], parent, f.back, connected=i > 0)
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def build_plumb() -> bpy.types.Object:
    """The small weight that hangs from the cord: a hair of line, a collar, and a six-sided bob drawn to a
    point. Its origin is the top of its line."""
    bm = bmesh.new()

    def lathe(profile, sides):
        rows = [[bm.verts.new(gb(r * math.sin(k * math.tau / sides), y, r * math.cos(k * math.tau / sides))) for k in range(sides)]
                for y, r in profile]
        for a, b in zip(rows, rows[1:]):
            for k in range(sides):
                j = (k + 1) % sides
                bm.faces.new([a[k], a[j], b[j], b[k]])
        bm.faces.new(rows[0][::-1])
        bm.faces.new(rows[-1])

    lathe([(0.0, 0.0055), (-0.45, 0.0055)], 4)
    lathe([(-0.44, 0.011), (-0.455, 0.027), (-0.47, 0.027), (-0.485, 0.013), (-0.50, 0.015), (-0.565, 0.058),
           (-0.585, 0.058), (-0.76, 0.004)], 6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    col = bm.loops.layers.float_color.new(COLOR)
    for face in bm.faces:
        for loop in face.loops:
            loop[col] = (0.0, 0.5, 1.0, 1.0)
    mesh = bpy.data.meshes.new("plumb")
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new("plumb", mesh)
    bpy.context.scene.collection.objects.link(obj)
    for poly in mesh.polygons:
        poly.use_smooth = False
    mesh.color_attributes.active_color = mesh.color_attributes[COLOR]
    mesh.color_attributes.render_color_index = mesh.color_attributes.find(COLOR)
    return obj


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

def render_previews(rig: bpy.types.Object, hand: bpy.types.Object, fingers: dict[str, Finger], folder: str) -> None:
    """Pictures of the hand at rest and with every finger bent, to check the shape and the skinning."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 20
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 1000, 700
    scene.world = bpy.data.worlds.new("World")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.36, 0.38, 0.40, 1)

    material = bpy.data.materials.new("preview")
    material.use_nodes = True
    material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.5, 0.49, 0.47, 1)
    material.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.45
    hand.data.materials.append(material)

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.angle = 0.2
    sun.rotation_euler = (math.radians(52), 0, math.radians(35))
    scene.collection.objects.link(sun)
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.lens = 60
    scene.collection.objects.link(camera)
    scene.camera = camera

    def look(position: Vector, target: Vector):
        camera.location = gb(*position)
        forward = (gb(*target) - camera.location).normalized()
        camera.rotation_euler = forward.to_track_quat("-Z", "Y").to_euler()

    def curl(amounts: dict[str, float]):
        for f in fingers.values():
            for i, name in enumerate(f.bones):
                pb = rig.pose.bones[name]
                pb.rotation_mode = "XYZ"
                degrees = amounts.get(f.name, 0.0) * ((0.55, 0.5, 0.4) if f.name == "thumb" else (1.0, 1.05, 0.7))[i]
                pb.rotation_euler = (-math.radians(degrees), 0.0, 0.0)
        bpy.context.view_layer.update()

    os.makedirs(folder, exist_ok=True)
    shots = {
        "rest_top": ({}, V((-0.3, 10.5, -0.9)), V((-0.3, 0, -1.0))),
        "rest_palm": ({}, V((-0.3, -10.5, -0.9)), V((-0.3, 0, -1.0))),
        "rest_side": ({}, V((-9.0, 2.0, -1.2)), V((0, 0, -1.2))),
        "rest_front": ({}, V((-3.2, 3.2, -9.0)), V((-0.2, 0.0, -1.6))),
        "rest_knuckles": ({}, V((2.4, 2.6, -5.2)), V((-0.1, 0.05, -2.2))),
        "thumb_under": ({}, V((-3.6, -4.4, -2.6)), V((-0.9, -0.1, -1.2))),
        "thumb_side": ({}, V((-5.5, 0.6, -0.2)), V((-0.9, -0.1, -1.3))),
        "tips": ({}, V((-0.9, 1.5, -5.6)), V((-0.2, 0.0, -3.2))),
        "wrist_back": ({}, V((1.2, 3.4, 3.6)), V((0.0, 0.0, -0.3))),
        "curl_side": ({n: 62 for n in fingers}, V((-8.5, 2.6, -1.0)), V((0, -0.3, -1.4))),
        "curl_under": ({n: 62 for n in fingers}, V((-3.5, -7.5, -5.0)), V((0, -0.2, -1.5))),
        "fist_front": ({n: 88 for n in fingers}, V((-3.0, 2.5, -9.0)), V((0, -0.2, -1.2))),
    }
    for name, (amounts, position, target) in shots.items():
        curl(amounts)
        look(position, target)
        scene.render.filepath = os.path.join(folder, f"hand_{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"rendered {scene.render.filepath}", flush=True)
    curl({})
    hand.data.materials.clear()
    bpy.data.objects.remove(sun)
    bpy.data.objects.remove(camera)


# ---------------------------------------------------------------------------

def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="public/assets")
    ap.add_argument("--preview", default=None, help="folder for check renders of the rest and bent poses")
    a = ap.parse_args(argv)
    out = os.path.abspath(a.out)

    lib.reset_scene()
    fingers = build_fingers()
    hand, knot = build_hand(fingers)
    rig = build_armature(fingers)
    hand.parent = rig
    modifier = hand.modifiers.new("rig", "ARMATURE")
    modifier.object = rig
    plumb = build_plumb()

    tris = sum(len(p.vertices) - 2 for p in hand.data.polygons)
    print(f"hand: {len(hand.data.vertices)} vertices, {tris} triangles, {len(rig.data.bones)} bones", flush=True)

    # Check the rig before trusting it: bending a finger must bring its tip toward the palm.
    probe = rig.pose.bones["index1"]
    probe.rotation_mode = "XYZ"
    tip_before = (rig.matrix_world @ rig.pose.bones["index3"].tail).copy()
    probe.rotation_euler = (-math.radians(40), 0.0, 0.0)
    bpy.context.view_layer.update()
    tip_after = (rig.matrix_world @ rig.pose.bones["index3"].tail).copy()
    probe.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    assert tip_after.z < tip_before.z - 0.3, "a negative turn about a finger bone's x axis should bend it toward the palm"

    hand["meta"] = json.dumps({
        "length": round(-fingers["middle"].joints[3].z, 4),
        "fingers": {f.name: {"bones": f.bones, "lengths": [round(x, 4) for x in f.lengths],
                             "radii": [round(x, 4) for x in f.radii]} for f in fingers.values()},
        # A turn of this sign about a finger bone's own x axis bends it toward the palm.
        "flexSign": -1,
        "palmNormal": [0, -1, 0],
        "forward": [0, 0, -1],
        "thumbSide": -1,
        # Wrist to the far end of the forearm, and half its width and half its depth there.
        "forearmLength": FOREARM_LENGTH,
        "forearmEnd": [ARM_HALF_WIDTH[-1], ARM_HALF_DEPTH[-1]],
        "cord": [0.17, 0.40],
        # Where the plumb line is tied: the knot in the cord.
        "plumbAnchor": [round(float(x), 4) for x in knot],
    })

    if a.preview:
        render_previews(rig, hand, fingers, os.path.abspath(a.preview))

    path = os.path.join(out, "hand.glb")
    os.makedirs(out, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in (rig, hand, plumb):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_normals=True,
        export_texcoords=False,
        export_tangents=False,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_active_vertex_color_when_no_material=True,
        export_all_vertex_colors=False,
        export_extras=True,
        export_animations=False,
        export_skins=True,
        export_all_influences=False,
        export_def_bones=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"exported {path} ({os.path.getsize(path) / 1024:.0f} KB)", flush=True)


if __name__ == "__main__":
    main()
