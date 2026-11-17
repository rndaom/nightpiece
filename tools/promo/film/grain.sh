#!/bin/sh
# The paper's grain, made from noise: fine tooth, fibres lying two ways, slow mottling and a few dark flecks.
# It is laid over a card's colour by multiplying, and it tiles.  Usage: grain.sh <out.png>
set -e
t=$(mktemp -d)
magick -size 1024x1024 -seed 11 xc:gray50 +noise Gaussian -colorspace Gray -virtual-pixel tile -blur 0x0.6 -normalize +level 88%,100% "$t/a.png"
magick -size 1024x1024 -seed 23 xc:gray50 +noise Gaussian -colorspace Gray -virtual-pixel tile -motion-blur 0x14+20 -normalize +level 92%,100% "$t/b.png"
magick -size 1024x1024 -seed 37 xc:gray50 +noise Gaussian -colorspace Gray -virtual-pixel tile -motion-blur 0x10+110 -normalize +level 93%,100% "$t/c.png"
magick -size 1024x1024 -seed 5 xc:gray50 +noise Gaussian -colorspace Gray -virtual-pixel tile -blur 0x48 -normalize +level 93%,100% "$t/d.png"
magick -size 1024x1024 -seed 71 xc:gray50 +noise Gaussian -colorspace Gray -virtual-pixel tile -blur 0x1.2 -normalize -threshold 98.3% -negate -virtual-pixel tile -blur 0x0.5 +level 72%,100% "$t/e.png"
magick "$t/a.png" "$t/b.png" -compose Multiply -composite "$t/c.png" -compose Multiply -composite "$t/d.png" -compose Multiply -composite "$t/e.png" -compose Multiply -composite -fill white -colorize 45% "$1"
rm -r "$t"
