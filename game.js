/* ==========================================================================
   Dot Connect — game logic

   How the game works
   - The board is a square grid of dots. On your turn you claim one empty dot.
   - Claimed dots link up with neighbouring dots you own (any of 8 directions).
   - The first player whose straight line (horizontal, vertical or diagonal)
     reaches the "dots to win" number wins. If the board fills up, it's a draw.

   Touch support
   - Every dot's tap target is its whole grid cell (see .hit in buildBoard).
   - When dots are too small to tap accurately, a first tap "aims" at a dot
     and a second tap on the same dot places it (see handleTap).
   - On small screens the setup controls live in a bottom sheet (see setSetupOpen).

   File layout
   1. CONFIG        – change these values to tune the game
   2. State         – what the game remembers
   3. Rules         – pure logic: who owns what, line detection
   4. Board drawing – building and updating the SVG board
   5. UI rendering  – status bar and player list
   6. Sound         – synthesised sound effects (Web Audio API)
   7. Touch input   – tapping, aiming, haptics
   8. Setup sheet   – the small-screen bottom sheet
   9. Controls      – setup controls, mouse and keyboard input
   ========================================================================== */

'use strict';

/* ==========================================================================
   1. CONFIG
   ========================================================================== */

const CONFIG = {
  players: 2,      // default number of players (the radio buttons in index.html offer 2–4)
  boardSize: 5,    // default dots per side (the board is always square)
  dotsToWin: 3,    // default minimum dots in one straight line needed to win

  // Ranges offered in the setup dropdowns.
  limits: {
    boardSize: [5, 12],
    dotsToWin: [3, 6],
  },

  // Names shown in the UI. Add more here if you add more players.
  playerNames: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],

  // Drawing sizes, in SVG units. The board scales to fit the screen, so these
  // only change proportions, not the on-screen size.
  cell: 56,          // distance between neighbouring dots
  dotRadius: 18,     // radius of a claimed dot
  emptyRadius: 5,    // radius of an unclaimed dot

  // Touch tuning
  minTouchCell: 32,  // on touch screens, cells smaller than this many CSS pixels
                     // use two-step placement (tap to aim, tap again to place)

  // Screens matching this get the compact layout and the setup bottom sheet.
  // Keep in sync with the compact breakpoint in style.css.
  compactQuery: '(max-width: 880px), (max-height: 560px)',
};

// The four line directions we check, as [rowStep, colStep]:
// right, down, down-right, down-left. Each is scanned both ways from a dot.
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

// All eight neighbours (each direction and its opposite), used to link dots.
const NEIGHBOURS = DIRECTIONS.flatMap(([dr, dc]) => [[dr, dc], [-dr, -dc]]);

/* ==========================================================================
   2. STATE
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// Cached page elements
const els = {
  masthead: $('masthead'),
  stage: $('stage'),
  playersSection: $('players-section'),
  board: $('board'),
  status: $('status'),
  statusSwatch: $('status-swatch'),
  statusText: $('status-text'),
  statusDetail: $('status-detail'),
  goal: $('goal'),
  goalCount: $('goal-count'),
  aimHint: $('aim-hint'),
  playAgain: $('play-again'),
  playerList: $('player-list'),
  playerRadios: document.querySelectorAll('input[name="players"]'),
  winSelect: $('win-length'),
  sizeSelect: $('board-size'),
  touchSelect: $('touch-mode'),
  newGame: $('new-game'),
  soundToggle: $('sound-toggle'),
  setupPanel: $('setup-panel'),
  setupToggle: $('setup-toggle'),
  setupClose: $('setup-close'),
  backdrop: $('backdrop'),
};

// Setup chosen in the controls. Starts from CONFIG, clamped to the allowed ranges.
const clamp = (n, [min, max]) => Math.min(max, Math.max(min, n));
const settings = {
  players: clamp(CONFIG.players, [2, CONFIG.playerNames.length]),
  boardSize: clamp(CONFIG.boardSize, CONFIG.limits.boardSize),
  dotsToWin: clamp(CONFIG.dotsToWin, CONFIG.limits.dotsToWin),
  touchMode: 'auto',   // 'auto' | 'once' | 'twice' (not part of a game; changing it keeps the game)
};

// The game in progress (created by startGame)
let game = null;

// SVG bits we keep hold of so moves can update the board without redrawing it
let dotEls = [];      // dotEls[row][col] -> <g> for that dot
let layers = {};      // { segments, win, dots } SVG groups, drawn back to front
let rovingDot = null; // the one dot that is reachable with the Tab key

// Sound: on by default, remembered across visits. localStorage can throw in
// some private-browsing modes, so every read/write of it is guarded.
let muted = false;
try { muted = localStorage.getItem('dotConnectMuted') === '1'; } catch { /* ignore */ }

// Touch state
let aimedDot = null;  // the dot currently "aimed at" in two-step mode
let cellPx = Infinity; // on-screen size of one grid cell, in CSS pixels

// Media queries we react to
const coarsePointer = window.matchMedia('(pointer: coarse)');
const compactMode = window.matchMedia(CONFIG.compactQuery);

/* ==========================================================================
   3. RULES (pure logic, no drawing)
   ========================================================================== */

const playerName = (p) => CONFIG.playerNames[p] || `Player ${p + 1}`;

/** True if (r, c) is on the board and owned by player p. */
function owns(r, c, p) {
  return r >= 0 && r < game.size && c >= 0 && c < game.size && game.grid[r][c] === p;
}

/**
 * For the dot just placed at (r, c), find the straight line of player p's dots
 * running through it in each of the four directions.
 * Each line is an ordered list of [row, col] cells from one end to the other.
 */
function linesThrough(r, c, p) {
  return DIRECTIONS.map(([dr, dc]) => {
    const line = [[r, c]];
    for (let i = 1; owns(r + dr * i, c + dc * i, p); i++) line.push([r + dr * i, c + dc * i]);
    for (let i = 1; owns(r - dr * i, c - dc * i, p); i++) line.unshift([r - dr * i, c - dc * i]);
    return line;
  });
}

/** Play one turn: claim (r, c) for the current player, then check for a win or draw. */
function play(r, c) {
  if (!game || game.over || game.grid[r][c] !== null) return;

  setAim(null);

  const p = game.current;
  game.grid[r][c] = p;
  game.moves += 1;

  claimDot(r, c, p);
  linkToNeighbours(r, c, p);
  buzz(12);
  playPlace(p);

  const lines = linesThrough(r, c, p);
  const longest = Math.max(...lines.map((line) => line.length));
  game.best[p] = Math.max(game.best[p], longest);

  const winningLines = lines.filter((line) => line.length >= game.goal);

  if (winningLines.length > 0) {
    // Win: this player linked enough dots. (Two lines at once are both shown.)
    game.over = true;
    game.winner = p;
    game.winLength = longest;
    showWinningLines(winningLines, p);
    buzz([40, 60, 40, 60, 120]);
    playWin();
  } else if (game.moves === game.size * game.size) {
    // Draw: every dot is claimed and nobody has a long enough line.
    game.over = true;
    playDraw();
  } else {
    // Otherwise it's the next player's turn.
    game.current = (p + 1) % game.playerCount;
  }

  render();
}

/* ==========================================================================
   4. BOARD DRAWING
   ========================================================================== */

/** Create an SVG element with attributes, optionally appended to a parent. */
function svgEl(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (parent) parent.appendChild(node);
  return node;
}

/** SVG coordinates of the centre of a dot. */
const center = (r, c) => ({ x: (c + 0.5) * CONFIG.cell, y: (r + 0.5) * CONFIG.cell });

/** Screen-reader label for an empty dot. */
const emptyLabel = (r, c, aimed = false) =>
  `Row ${r + 1}, column ${c + 1}, empty${aimed ? '. Selected. Tap again to place.' : ''}`;

/** Build a fresh, empty board for the current game. */
function buildBoard() {
  const { size } = game;
  const span = size * CONFIG.cell;

  els.board.replaceChildren();
  els.board.setAttribute('viewBox', `0 0 ${span} ${span}`);

  // Layers, back to front: links between dots, winning line, then the dots.
  layers = {
    segments: svgEl('g', {}, els.board),
    win: svgEl('g', {}, els.board),
    dots: svgEl('g', {}, els.board),
  };

  dotEls = [];
  rovingDot = null;

  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      const { x, y } = center(r, c);
      const half = CONFIG.cell / 2;
      const dot = svgEl('g', {
        class: 'dot empty',
        'data-row': r,
        'data-col': c,
        role: 'button',
        tabindex: -1,
        'aria-label': emptyLabel(r, c),
      }, layers.dots);

      // Tap target: the whole grid cell (squares tile the board, so a tap always
      // lands on exactly one dot: the nearest one).
      svgEl('rect', { class: 'hit', x: x - half, y: y - half, width: CONFIG.cell, height: CONFIG.cell }, dot);
      svgEl('circle', { class: 'ring', cx: x, cy: y, r: CONFIG.dotRadius + 7 }, dot); // keyboard / aim ring
      svgEl('circle', { class: 'core', cx: x, cy: y, r: CONFIG.emptyRadius }, dot);   // the visible dot
      svgEl('text', { class: 'label', x, y, dy: '0.35em' }, dot);                     // player number

      row.push(dot);
    }
    dotEls.push(row);
  }

  // Keyboard users Tab into the board once, then use the arrow keys.
  setRovingDot(Math.floor(size / 2), Math.floor(size / 2));
  measureBoard();
}

/** Make one dot the only Tab stop on the board. */
function setRovingDot(r, c) {
  if (rovingDot) rovingDot.setAttribute('tabindex', '-1');
  rovingDot = dotEls[r][c];
  rovingDot.setAttribute('tabindex', '0');
}

/** Colour a dot with its owner's colour and number. */
function claimDot(r, c, p) {
  const dot = dotEls[r][c];
  dot.classList.remove('empty', 'aiming');
  dot.classList.add('owned', `p-${p}`);
  dot.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}, claimed by ${playerName(p)}`);
  dot.setAttribute('aria-disabled', 'true');
  dot.querySelector('.core').setAttribute('r', CONFIG.dotRadius);
  dot.querySelector('.label').textContent = p + 1;
}

/** Draw a line between two dots in a player's colour. */
function drawLine(r1, c1, r2, c2, p, className, parent) {
  const a = center(r1, c1);
  const b = center(r2, c2);
  const line = svgEl('line', { class: `${className} p-${p}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y }, parent);
  return { line, length: Math.hypot(b.x - a.x, b.y - a.y) };
}

/**
 * Link a newly claimed dot to each neighbouring dot the same player owns.
 * Each pair is linked exactly once: when the second of the two is placed.
 */
function linkToNeighbours(r, c, p) {
  for (const [dr, dc] of NEIGHBOURS) {
    if (owns(r + dr, c + dc, p)) drawLine(r, c, r + dr, c + dc, p, 'seg', layers.segments);
  }
}

/** Highlight the winning line(s): draw a bold stroke and mark the dots. */
function showWinningLines(lines, p) {
  for (const cells of lines) {
    const [r1, c1] = cells[0];
    const [r2, c2] = cells[cells.length - 1];
    const { line, length } = drawLine(r1, c1, r2, c2, p, 'win-line', layers.win);
    line.style.setProperty('--len', length); // used by the draw-on animation
    for (const [r, c] of cells) dotEls[r][c].classList.add('win');
  }
}

/** Measure how big one grid cell is on screen (CSS pixels). */
function measureBoard() {
  if (!game) return;
  const width = els.board.getBoundingClientRect().width;
  if (width > 0) cellPx = width / game.size;
}

/* ==========================================================================
   5. UI RENDERING
   ========================================================================== */

/** Small helper for building HTML elements. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Refresh everything that changes from turn to turn. */
function render() {
  els.goalCount.textContent = game.goal;
  els.board.classList.toggle('over', game.over);
  // The board reads this to tint the hover / aim preview with the current player's colour.
  els.board.style.setProperty('--turn-color', `var(--player-${game.current})`);
  renderStatus();
  renderHints();
  renderPlayers();
}

/** The bar above the board: whose turn it is, or how the game ended. */
function renderStatus() {
  if (game.winner !== null) {
    setStatus('win', game.winner, `${playerName(game.winner)} wins`, ` with ${game.winLength} in a row!`);
  } else if (game.over) {
    setStatus('draw', null, "It's a draw", '. The board is full.');
  } else {
    setStatus('turn', game.current, `${playerName(game.current)}'s turn`);
  }
}

function setStatus(mode, player, text, detail = '') {
  els.status.dataset.mode = mode;
  els.status.className = player === null ? 'status' : `status p-${player}`;
  els.statusSwatch.textContent = player === null ? '' : player + 1;
  els.statusText.textContent = text;
  // On narrow screens the detail is hidden visually (screen readers still read it)
  els.statusDetail.textContent = detail;
}

/** Right of the status: the goal, an "aim" prompt, or a Play again button. */
function renderHints() {
  els.goal.hidden = game.over || aimedDot !== null;
  els.aimHint.hidden = game.over || aimedDot === null;
  els.playAgain.hidden = !game.over;
}

/** The player list: highlights whose turn it is and shows each longest line so far. */
function renderPlayers() {
  els.playerList.replaceChildren();

  for (let p = 0; p < game.playerCount; p++) {
    const isActive = !game.over && p === game.current;
    const item = el('li', `player p-${p}${isActive ? ' active' : ''}${game.winner === p ? ' winner' : ''}`);
    if (isActive) item.setAttribute('aria-current', 'true');

    // Pips on wide screens...
    const pips = el('span', 'pips');
    pips.setAttribute('role', 'img');
    pips.setAttribute('aria-label', `Longest line: ${game.best[p]} of ${game.goal}`);
    for (let i = 0; i < game.goal; i++) pips.append(el('i', `pip${i < game.best[p] ? ' on' : ''}`));

    // ...and a compact "2/4" on small ones (style.css shows one or the other).
    const count = el('span', 'count', `${game.best[p]}/${game.goal}`);
    count.setAttribute('aria-hidden', 'true');

    item.append(el('span', 'badge', p + 1), el('span', 'name', playerName(p)), pips, count);
    els.playerList.append(item);
  }
}

/* ==========================================================================
   6. SOUND
   All effects are synthesised with the Web Audio API, so there are no audio
   files to ship. Each play*() function is safe to call even when sound is
   muted or the browser has no Web Audio support: it just does nothing.
   ========================================================================== */

let audioCtx = null;

/**
 * Get the shared AudioContext, creating (or resuming) it on demand.
 * Browsers only allow audio to start from a real user gesture, so this is
 * only ever called from inside a click/tap/key handler — never on its own.
 */
function audioContext() {
  if (muted) return null;
  if (!audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null; // no Web Audio support: sound quietly does nothing
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Play one short tone at `time` (an AudioContext timestamp), then let it fade. */
function tone(ctx, time, freq, duration, { type = 'sine', peak = 0.18 } = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  // Exponential ramps avoid the click a sudden on/off would make.
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(time);
  osc.stop(time + duration + 0.03);
}

/** A soft click when a dot is claimed. Pitch varies a little by player. */
function playPlace(player) {
  const ctx = audioContext();
  if (!ctx) return;
  tone(ctx, ctx.currentTime, 360 + (player % 4) * 34, 0.1, { type: 'sine', peak: 0.16 });
}

/** A brief tick while aiming, in two-step touch mode. */
function playAim() {
  const ctx = audioContext();
  if (!ctx) return;
  tone(ctx, ctx.currentTime, 880, 0.045, { type: 'triangle', peak: 0.08 });
}

/** A rising four-note chime when someone completes a winning line. */
function playWin() {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    tone(ctx, t + i * 0.11, freq, 0.22, { type: 'triangle', peak: 0.2 });
  });
}

/** A plain two-note tone for a draw: neither a win nor a loss. */
function playDraw() {
  const ctx = audioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  [392, 329.63].forEach((freq, i) => tone(ctx, t + i * 0.16, freq, 0.3, { type: 'sine', peak: 0.15 }));
}

/** Reflect the muted state on the toggle button and remember it for next time. */
function syncSoundButton() {
  els.soundToggle.setAttribute('aria-pressed', String(muted));
  const label = muted ? 'Unmute sound effects' : 'Mute sound effects';
  els.soundToggle.querySelector('.sr-only').textContent = label;
  els.soundToggle.setAttribute('title', label);
}

/* ==========================================================================
   7. TOUCH INPUT
   ========================================================================== */

/** Short vibration on phones that support it (ignored elsewhere). */
function buzz(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

/**
 * Should a tap only "aim" first? Yes when the person chose "tap twice", or in
 * Automatic mode on a touch screen whose dots are too small to hit reliably.
 */
function usesTwoStep() {
  if (settings.touchMode === 'twice') return true;
  if (settings.touchMode === 'once') return false;
  return coarsePointer.matches && cellPx < CONFIG.minTouchCell;
}

/** Mark one dot as "aimed at" (or pass null to clear the aim). */
function setAim(dot) {
  if (aimedDot) {
    aimedDot.classList.remove('aiming');
    aimedDot.setAttribute('aria-label', emptyLabel(+aimedDot.dataset.row, +aimedDot.dataset.col));
  }
  aimedDot = dot;
  if (dot) {
    dot.classList.add('aiming');
    dot.setAttribute('aria-label', emptyLabel(+dot.dataset.row, +dot.dataset.col, true));
    buzz(8);
    playAim();
  }
  if (game) renderHints();
}

/** A tap or click on a dot. */
function handleTap(dot) {
  const r = Number(dot.dataset.row);
  const c = Number(dot.dataset.col);
  if (game.over || game.grid[r][c] !== null) return;

  // Two-step mode: the first tap aims, tapping the same dot again places it.
  if (usesTwoStep() && aimedDot !== dot) {
    setAim(dot);
    return;
  }
  play(r, c);
}

/* ==========================================================================
   8. SETUP SHEET (small screens)
   On large screens the setup panel is part of the sidebar and this does nothing.
   On small screens it is a bottom sheet: while open, the rest of the page is
   made inert so touch, keyboard and screen readers stay inside the sheet.
   ========================================================================== */

let setupOpen = false;

function setSetupOpen(open) {
  const willOpen = open && compactMode.matches;
  if (willOpen === setupOpen) return;
  setupOpen = willOpen;

  els.setupPanel.classList.toggle('open', willOpen);
  els.backdrop.classList.toggle('show', willOpen);
  els.setupToggle.setAttribute('aria-expanded', String(willOpen));
  for (const node of [els.masthead, els.stage, els.playersSection]) node.inert = willOpen;

  (willOpen ? els.setupClose : els.setupToggle).focus();
}

/* ==========================================================================
   9. CONTROLS AND INPUT
   ========================================================================== */

/** Start a new game using the current settings. */
function startGame() {
  // A line can't be longer than the board is wide.
  settings.dotsToWin = Math.min(settings.dotsToWin, settings.boardSize);

  const size = settings.boardSize;
  game = {
    size,
    goal: settings.dotsToWin,
    playerCount: settings.players,
    grid: Array.from({ length: size }, () => Array(size).fill(null)), // null = empty, else player index
    current: 0,        // index of the player whose turn it is
    moves: 0,
    over: false,
    winner: null,      // player index once someone wins
    winLength: 0,      // length of the line that won
    best: Array(settings.players).fill(0), // each player's longest line so far
  };

  aimedDot = null;     // the old board (and its aimed dot) is about to be replaced
  syncControls();
  buildBoard();
  render();
}

/** Make the setup controls match the current settings. */
function syncControls() {
  els.playerRadios.forEach((radio) => {
    radio.checked = Number(radio.value) === settings.players;
  });
  els.sizeSelect.value = settings.boardSize;
  els.winSelect.value = settings.dotsToWin;
  els.touchSelect.value = settings.touchMode;

  // Don't offer lines longer than the board.
  for (const option of els.winSelect.options) {
    option.disabled = Number(option.value) > settings.boardSize;
  }
}

function fillSelect(select, [min, max], label) {
  for (let n = min; n <= max; n++) select.append(new Option(label(n), n));
}

function initControls() {
  fillSelect(els.sizeSelect, CONFIG.limits.boardSize, (n) => `${n} × ${n} dots`);
  fillSelect(els.winSelect, CONFIG.limits.dotsToWin, (n) => `${n} in a line`);

  els.playerRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      settings.players = Number(radio.value);
      startGame();
    });
  });
  els.sizeSelect.addEventListener('change', () => {
    settings.boardSize = Number(els.sizeSelect.value);
    startGame();
  });
  els.winSelect.addEventListener('change', () => {
    settings.dotsToWin = Number(els.winSelect.value);
    startGame();
  });
  els.touchSelect.addEventListener('change', () => {
    settings.touchMode = els.touchSelect.value;
    setAim(null); // keep the current game, just change how taps behave
  });

  els.newGame.addEventListener('click', () => {
    startGame();
    setSetupOpen(false);
  });
  els.playAgain.addEventListener('click', startGame);

  // Sound toggle: also unlocks the AudioContext, since this click is a user gesture.
  syncSoundButton();
  els.soundToggle.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('dotConnectMuted', muted ? '1' : '0'); } catch { /* ignore */ }
    syncSoundButton();
    if (!muted) playAim();
  });

  // Setup sheet (small screens)
  els.setupToggle.addEventListener('click', () => setSetupOpen(!setupOpen));
  els.setupClose.addEventListener('click', () => setSetupOpen(false));
  els.backdrop.addEventListener('click', () => setSetupOpen(false));
  compactMode.addEventListener('change', () => setSetupOpen(false));

  // Escape closes the sheet, or cancels an aimed dot
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (setupOpen) setSetupOpen(false);
    else if (aimedDot) setAim(null);
  });

  // iOS Safari only shows :active styles (our tap preview) if some touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });

  // Re-measure the cells whenever the board changes size (rotation, resize, sheet size).
  if ('ResizeObserver' in window) new ResizeObserver(measureBoard).observe(els.board);
}

/** Mouse / touch and keyboard input, handled once for the whole board. */
function initBoardInput() {
  els.board.addEventListener('click', (event) => {
    const dot = event.target.closest('.dot');
    if (dot) handleTap(dot);
  });

  // Remember the last focused dot so Tab returns to it.
  els.board.addEventListener('focusin', (event) => {
    const dot = event.target.closest('.dot');
    if (dot) setRovingDot(Number(dot.dataset.row), Number(dot.dataset.col));
  });

  const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

  els.board.addEventListener('keydown', (event) => {
    const dot = event.target.closest('.dot');
    if (!dot) return;
    const r = Number(dot.dataset.row);
    const c = Number(dot.dataset.col);

    if (ARROWS[event.key]) {
      event.preventDefault();
      const [dr, dc] = ARROWS[event.key];
      const nr = Math.min(game.size - 1, Math.max(0, r + dr));
      const nc = Math.min(game.size - 1, Math.max(0, c + dc));
      dotEls[nr][nc].focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      // Keyboard players place directly; two-step aiming is only for taps.
      event.preventDefault();
      play(r, c);
    }
  });
}

/* ---------- Go! ---------- */
initControls();
initBoardInput();
startGame();
window.dotConnectReady = true; // lets index.html know the game started