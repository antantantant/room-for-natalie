# Room for Natalie

A cute, pastel 3D model of a small home, built from a pencil sketch with [three.js](https://threejs.org). Press **Begin the sunrise** and the home goes from dark, one minute before the sun comes up, to morning light pouring in through the east windows, with a breeze in the bedroom curtains and music-box music. Click any lamp to switch it on or off.

The home sits high in a hilltop town in Tuscany. The wall with the TV faces east: its window, and a second one in the bedroom, look out over the valley under drifting clouds. The open bedroom window looks south across a lane at the neighbours' roofs and the bell tower.

## The plan

The sketch draws the same floor plan twice, once with each half filled in. Combined, it is one home in three parts (the top of the page is the TV wall, which faces east):

- **Living room, dining and kitchen (left of the page):** TV on a console, an L-shaped sofa facing it (chaise on its left) on a flower rug, a window with tied-back curtains and a lamp, a kitchen run on the north wall with the fridge in the corner, a dining table for four, a closet built into the west wall, and the front door with a "Hi" mat.
- **Bedroom (top right):** a loft bed over a desk with Natalie's yellow plush chick on it, a floor lamp, a plant in a spotty pot, a print on the wall, a low dresser, and two windows.
- **Bathroom (bottom right):** an oval tub, a fringed bath mat, a pedestal basin with a round mirror, a toilet, and a glass shower enclosure with a door.

Positions are measured off the sketch and scaled so the bed is 2.0 m long, which makes the home about 8.4 m × 6.0 m. Colours are a pastel interpretation, since the sketch is in pencil.

## Running it

Serve the folder with any static server (for example `python3 -m http.server`) and open `index.html`. Drag to rotate, scroll to zoom. There is no build step; three.js loads from a CDN.

## How it renders

The rendering pipeline is shared with [Apartment Room for Max](https://github.com/antantantant/room-for-max): an HDR chain with ambient occlusion, volumetric sunbeams, bloom, ACES tone mapping and SMAA, tuned to run on a MacBook Air. Soft things (the rug, duvet, cushions, mats, the chick and the plush rabbit) wear a coat of fibres drawn as stacked shells.

- `index.html` — page, camera, controls and the sunrise clock.
- `src/scene.js` — the home: geometry, procedural textures, lighting and the view outside.
- `src/pipeline.js` — the renderer and post-processing chain.
- `src/audio.js` — the music, birdsong and wind, synthesised live with Web Audio (no audio files).

In the browser console, `__stats()` reports the current quality level, `__lamps()` lists which lamps are on, `__look([x, y, z], [x, y, z])` aims the camera, and `__at(12)` jumps to twelve minutes after sunrise.
