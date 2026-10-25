// Squid Game-style art for the host and phone pages. These are our own simple
// drawings in the game's pink/teal colours, not the show's artwork.

// A pigtailed doll. data-facing="back" shows the back of her head (green
// light); "front" shows her face with glowing eyes (red light).
function dollSVG() {
  return `<svg class="doll" data-facing="back" viewBox="0 0 120 200" role="img" aria-label="The doll">
    <rect class="doll-skin" x="46" y="160" width="10" height="34" rx="4"/>
    <rect class="doll-skin" x="64" y="160" width="10" height="34" rx="4"/>
    <rect class="doll-skin" x="20" y="104" width="10" height="44" rx="5"/>
    <rect class="doll-skin" x="90" y="104" width="10" height="44" rx="5"/>
    <path class="doll-dress" d="M38 104 L82 104 L98 168 L22 168 Z"/>
    <path class="doll-shirt" d="M36 96 H84 V112 H36 Z"/>
    <rect class="doll-skin" x="54" y="84" width="12" height="14"/>
    <g class="doll-head">
      <g class="doll-back">
        <circle class="doll-hair" cx="30" cy="50" r="13"/>
        <circle class="doll-hair" cx="90" cy="50" r="13"/>
        <rect class="doll-tie" x="24" y="60" width="12" height="6" rx="3"/>
        <rect class="doll-tie" x="84" y="60" width="12" height="6" rx="3"/>
        <circle class="doll-hair" cx="60" cy="56" r="32"/>
      </g>
      <g class="doll-front">
        <circle class="doll-hair" cx="30" cy="50" r="13"/>
        <circle class="doll-hair" cx="90" cy="50" r="13"/>
        <rect class="doll-tie" x="24" y="60" width="12" height="6" rx="3"/>
        <rect class="doll-tie" x="84" y="60" width="12" height="6" rx="3"/>
        <circle class="doll-skin" cx="60" cy="58" r="30"/>
        <path class="doll-hair" d="M30 54 A30 30 0 0 1 90 54 Q76 42 60 44 Q44 42 30 54 Z"/>
        <circle class="doll-eye" cx="49" cy="62" r="4.5"/>
        <circle class="doll-eye" cx="71" cy="62" r="4.5"/>
        <circle class="doll-cheek" cx="43" cy="73" r="4"/>
        <circle class="doll-cheek" cx="77" cy="73" r="4"/>
        <path class="doll-mouth" d="M54 76 Q60 80 66 76"/>
      </g>
    </g>
  </svg>`;
}

// A guard in a hooded suit with a shape on the mask: 'circle', 'triangle' or 'square'.
function guardSVG(shape) {
  const marks = {
    circle: '<circle class="guard-mark" cx="50" cy="44" r="9"/>',
    triangle: '<path class="guard-mark" d="M50 33 L61 53 L39 53 Z"/>',
    square: '<rect class="guard-mark" x="41" y="35" width="18" height="18"/>',
  };
  return `<svg class="guard" viewBox="0 0 100 170" role="img" aria-label="A guard">
    <rect class="guard-suit" x="30" y="124" width="16" height="42" rx="6"/>
    <rect class="guard-suit" x="54" y="124" width="16" height="42" rx="6"/>
    <rect class="guard-suit" x="8" y="74" width="16" height="56" rx="8"/>
    <rect class="guard-suit" x="76" y="74" width="16" height="56" rx="8"/>
    <rect class="guard-suit" x="20" y="64" width="60" height="72" rx="20"/>
    <rect class="guard-belt" x="20" y="108" width="60" height="6"/>
    <circle class="guard-suit" cx="50" cy="44" r="32"/>
    <ellipse class="guard-mask" cx="50" cy="44" rx="22" ry="25"/>
    ${marks[shape]}
  </svg>`;
}

// Turns the doll to face the players (red light) or away (green light),
// with a quick spin when she changes direction.
function setDollFacing(doll, front) {
  const facing = front ? 'front' : 'back';
  if (!doll || doll.dataset.facing === facing) return;
  doll.dataset.facing = facing;
  doll.classList.remove('turning');
  void doll.getBoundingClientRect(); // restart the spin animation
  doll.classList.add('turning');
}
