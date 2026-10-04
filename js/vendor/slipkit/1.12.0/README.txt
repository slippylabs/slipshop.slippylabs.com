SlipKit 1.12.0, core only, from SlipStudio.

Copied with:
    ~/studio.slippylabs.com/tools/kitcopy.sh ~/slipshop.slippylabs.com --core-only

...and then PRUNED to the one module this app actually imports. kitcopy brings
all 45 core modules; 44 of them were unreachable here, and one of those
(physics.js) imports Rapier, which --core-only deliberately does not copy -- so
shipping the untouched copy meant shipping a file with an import that could not
resolve.

Kept: noise.js (tileable Perlin/simplex/value/Worley). It is self-contained.

Why vendor it at all: the studio's oracle holds this module bit-identical to
the live noise-lab tool, so SlipShop's Clouds filter produces the same field as
Noise Lab rather than a second, slightly different implementation.

If you re-run kitcopy, prune again.
