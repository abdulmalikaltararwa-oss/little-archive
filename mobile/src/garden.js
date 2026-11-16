// The bed of text-art flowers along the foot of the hero band on the first-launch and sign-in screens (ui.js draws the band,
// native.css styles it). Decoration only: the bed is aria-hidden, holds nothing that takes focus or a tap, and cannot be
// selected. Every plant is a <pre dir="ltr">, so its slashes and brackets are never mirrored in a right-to-left page.
//
// The plants are plain ASCII, so every column lines up in the mono face. Each species is a head, which takes one of the
// flower colours (ui/DESIGN.md, the flower tokens), and a stem in sage; all its rows are one width. The shell cannot import
// from ui/, so this is the shell's own small copy of the drawing: a garden in the interface has to be kept like it by hand.
const R = String.raw;
const SPECIES = {
  daisy: { tone: 'petal', head: [R`   _   `, R` _(_)_ `, R`(_)@(_)`, R`  (_)  `], stem: [R`   |   `, R`  \|/  `] },
  tulip: { tone: 'petal', head: [R` _ _ `, R`( V )`, R` \_/ `], stem: [R`  |  `, R`  |/ `, R` \|  `, R`  |  `] },
  sunflower: { tone: 'butter', head: [R` .\|/. `, R`--(@)--`, R` '/|\' `], stem: [R`   |   `, R`  \|   `, R`   |/  `, R`   |   `] },
  poppy: { tone: 'clay', head: [R` .--. `, R`( ** )`, R` '--' `], stem: [R`  ||  `, R` \||  `, R`  ||/ `] },
  lavender: { tone: 'lilac', head: [R`  i  `, R` i:i `, R` :i: `, R`  :  `], stem: [R`  |  `, R` \|  `, R`  |/ `] },
  bud: { tone: 'petal', head: [R` () `], stem: [R` || `, R`\||/`] },
  sprout: { tone: 'sage', head: [R` , `], stem: [R` |/`, R`\| `] },
  grass: { tone: 'sage', head: [], stem: [R`\|/`] },
  blade: { tone: 'sage', head: [], stem: [R`,;,`] },
};

// What is planted where. A plant is "species", "species:size" (l or xl) and may end in "?" for one that is left out on a
// narrow phone (native.css), so a bed never cuts a flower in half.
//   tall:    first launch, a full row under the headline.
//   compact: the other screens, where the form needs the room. Grass under the logo, and the flowers beside it, at the end
//            of the row, never behind the name.
const BEDS = {
  tall: [['grass:l?', 'tulip:l', 'daisy:xl', 'lavender:l', 'sunflower:xl', 'bud:l?', 'poppy:l']],
  compact: [['grass', 'blade', 'grass', 'blade?', 'grass'], ['tulip?', 'daisy', 'lavender?', 'sunflower']],
};

function plant(spec) {
  const [, name, size, narrow] = spec.match(/^(\w+)(?::(\w+))?(\?)?$/);
  const { tone, head, stem } = SPECIES[name];
  const node = document.createElement('pre');
  node.className = ['native-plant', `native-tone-${tone}`, size && `native-plant-${size}`, narrow && 'native-plant-roomy'].filter(Boolean).join(' ');
  node.setAttribute('dir', 'ltr');
  if (head.length) {
    const top = document.createElement('span');
    top.className = 'native-flower-head';
    top.textContent = head.join('\n');
    node.append(top, '\n');
  }
  node.append(stem.join('\n'));
  return node;
}

/** The bed for a band: `kind` is 'tall' or 'compact'. */
export function garden(kind) {
  const bed = document.createElement('div');
  bed.className = 'native-garden';
  bed.setAttribute('aria-hidden', 'true');
  for (const row of BEDS[kind]) {
    const group = document.createElement('div');
    group.className = 'native-garden-row';
    group.append(...row.map(plant));
    bed.append(group);
  }
  return bed;
}
