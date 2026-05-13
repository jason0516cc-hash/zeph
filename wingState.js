/**
 * waveManager.js — Waves mode state machine, rarity rolls, and spawn scheduling.
 *
 * State machine:
 *   IDLE → DAY → NIGHT → DAY → NIGHT → ...
 *
 *   DAY   — 1-minute grace / prep period. No mobs spawn.
 *   NIGHT — Mobs spawn and attack. Does NOT end until every tracked mob is dead.
 *
 * Biome: Garden (single biome for now — extend later)
 */

import { RARITIES } from './constants.js';
import { setWaveMapForWave } from './waveMap.js';
import { rollBossSpawn, spawnBoss, addNightLuck, onBossDied, isBossActive } from './bossManager.js';
import { hotbar } from './petals.js';

// ── Configurable constants ────────────────────────────────────────────────────
export const DAY_DURATION_MS    = 60_000;  // 1 minute prep / grace period
export const TRICKLE_WINDOW_MS  = 25_000;  // mobs trickle in over first 25s of night
export const TRICKLE_BURST      = 3;       // spawn N at a time per burst

/** Chance any burst slot becomes a structure (ant_hole or beehive) */
export const STRUCTURE_SPAWN_CHANCE = 0.12;

// ── Wave bands (mob count per wave) ──────────────────────────────────────────
// Lookup: first band whose maxWave >= current wave. Mirrors the Lua table exactly.
export const WAVE_BANDS = [
  { maxWave:   5, min:  1, max:  5 },
  { maxWave:  10, min:  2, max:  8 },
  { maxWave:  20, min:  4, max: 14 },
  { maxWave:  35, min:  6, max: 20 },
  { maxWave:  55, min:  8, max: 28 },
  { maxWave:  80, min: 10, max: 38 },
  { maxWave: 110, min: 12, max: 50 },
  { maxWave: 150, min: 15, max: 65 },
  { maxWave: 9999, min: 18, max: 80 },
];

// ── Rarity config ─────────────────────────────────────────────────────────────
// maxChance is a spawn weight (not 0-1); exitWave is where the rarity fully fades out.
export const RARITY_WAVE_CONFIG = [
  { name: 'Common',         earliestWave:   1, normalWave:   1, peakWave:   4, exitWave:   10, maxChance: 90, countDivisor:  1   },
  { name: 'Unusual',        earliestWave:   2, normalWave:   3, peakWave:   6, exitWave:   14, maxChance: 80, countDivisor:  1.1 },
  { name: 'Rare',           earliestWave:   5, normalWave:   7, peakWave:  12, exitWave:   20, maxChance: 70, countDivisor:  1.3 },
  { name: 'Epic',           earliestWave:   8, normalWave:  12, peakWave:  18, exitWave:   28, maxChance: 60, countDivisor:  1.6 },
  { name: 'Legendary',      earliestWave:  14, normalWave:  18, peakWave:  26, exitWave:   38, maxChance: 50, countDivisor:  2   },
  { name: 'Mythical',       earliestWave:  20, normalWave:  26, peakWave:  36, exitWave:   50, maxChance: 40, countDivisor:  2.5 },
  { name: 'Ultra',          earliestWave:  28, normalWave:  36, peakWave:  48, exitWave:   65, maxChance: 32, countDivisor:  3   },
  { name: 'Super',          earliestWave:  38, normalWave:  48, peakWave:  62, exitWave:   82, maxChance: 25, countDivisor:  3.8 },
  { name: 'Radiant',        earliestWave:  50, normalWave:  62, peakWave:  78, exitWave:  100, maxChance: 20, countDivisor:  4.8 },
  { name: 'Mystic',         earliestWave:  65, normalWave:  78, peakWave:  95, exitWave:  120, maxChance: 16, countDivisor:  6   },
  { name: 'Runic',          earliestWave:  82, normalWave:  95, peakWave: 115, exitWave:  145, maxChance: 12, countDivisor:  7.5 },
  { name: 'Seraphic',       earliestWave: 100, normalWave: 115, peakWave: 140, exitWave:  175, maxChance:  8, countDivisor:  9   },
  { name: 'Umbral',         earliestWave: 125, normalWave: 145, peakWave: 175, exitWave:  210, maxChance:  5, countDivisor: 12   },
  { name: 'Impracticality', earliestWave: 160, normalWave: 185, peakWave: 220, exitWave: 9999, maxChance:  3, countDivisor: 15   },
];

// ── Rarity math ───────────────────────────────────────────────────────────────

function smoothstep(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

export function getSpawnChance(cfg, wave) {
  if (wave < cfg.earliestWave || wave > cfg.exitWave) return 0;
  if (wave <= cfg.peakWave) {
    const range = Math.max(1, cfg.peakWave - cfg.earliestWave);
    return cfg.maxChance * smoothstep((wave - cfg.earliestWave) / range);
  }
  const range = Math.max(1, cfg.exitWave - cfg.peakWave);
  return cfg.maxChance * (1 - (wave - cfg.peakWave) / range);
}

/** Returns the RARITY_WAVE_CONFIG index of the rolled rarity for this wave. */
export function rollRarity(wave) {
  const weights = RARITY_WAVE_CONFIG.map(cfg => getSpawnChance(cfg, wave));
  const total   = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return 0;
}

/** Dominant rarity index — highest tier with nonzero spawn chance at this wave. */
export function getDominantRarityIndex(wave) {
  for (let i = RARITY_WAVE_CONFIG.length - 1; i >= 0; i--) {
    if (getSpawnChance(RARITY_WAVE_CONFIG[i], wave) > 0) return i;
  }
  return 0;
}

// ── Mob count for a wave ──────────────────────────────────────────────────────
export function getMobCountForWave(wave) {
  // Find first band whose maxWave >= current wave (same logic as Lua ipairs)
  const band = WAVE_BANDS.find(b => wave <= b.maxWave) ?? WAVE_BANDS[WAVE_BANDS.length - 1];
  return band.min + Math.floor(Math.random() * (band.max - band.min + 1));
}

// ── Wave state machine ────────────────────────────────────────────────────────

export const WaveState = Object.freeze({
  IDLE:      'IDLE',
  DAY:       'DAY',    // grace / prep period — no mobs
  NIGHT:     'NIGHT',  // mobs active — ends only when all tracked mobs are dead
  GAME_OVER: 'GAME_OVER',
});

export const waveState = {
  state:          WaveState.IDLE,
  waveNumber:     0,
  stateTimer:     0,   // ms elapsed in current state
  nightTimer:     0,   // ms elapsed in NIGHT (for HUD info only)
  totalMobs:      0,   // planned mob count this wave
  spawnedMobs:    0,   // how many have been spawned so far
  trackedMobIds:  new Set(), // living mob IDs that count toward clear
  spawnQueue:     [],  // { typeId, tier, isStructure }[]
  burstTimer:     0,   // ms until next spawn burst
  burstInterval:  0,   // ms between bursts
  dominantRarity: 0,   // RARITY_WAVE_CONFIG index
  dominantRarityName: 'Common',
  biome:          'Garden', // single biome for now
  highestWave:    0,   // highest wave reached this session (persists across restarts)
};

let _spawnCallback    = null; // (typeId, tier, isStructure) => mob id | null
let _gameOverCallback = null; // ()

/** Call once when entering waves mode. */
export function initWaveManager(spawnCb, gameOverCb) {
  _spawnCallback    = spawnCb;
  _gameOverCallback = gameOverCb;
  waveState.state         = WaveState.IDLE;
  waveState.waveNumber    = 0;
  waveState.trackedMobIds.clear();
  waveState.spawnQueue    = [];
}

/** Kick off the first wave (starts with a DAY phase). Pass startingWave > 1 for a mid-run restart. */
export function startWaves(startingWave = 1) {
  waveState.waveNumber = Math.max(0, startingWave - 1); // _transitionToDay will +1
  _transitionToDay();
}

/** Notify the manager that a tracked mob has died. */
export function onWaveMobDied(mobId) {
  waveState.trackedMobIds.delete(mobId);
  // If this was the active boss, clear boss state
  if (isBossActive()) onBossDied();
}

/** Add an extra mob ID to track — wave won't clear until it dies. */
export function addTrackedMob(mobId) {
  waveState.trackedMobIds.add(mobId);
}

/** Main update — call every frame with dt in ms. */
export function updateWaveManager(dt) {
  switch (waveState.state) {
    case WaveState.IDLE:      break;
    case WaveState.DAY:       _updateDay(dt);   break;
    case WaveState.NIGHT:     _updateNight(dt); break;
    case WaveState.GAME_OVER: break;
  }
}

/** Signal NPC death => game over. */
export function triggerWaveGameOver() {
  if (waveState.state === WaveState.GAME_OVER) return;
  waveState.state = WaveState.GAME_OVER;
  if (_gameOverCallback) _gameOverCallback();
}

/** Skip the current day phase and jump straight to night (player-triggered). */
export function skipToNight() {
  if (waveState.state !== WaveState.DAY) return;
  _transitionToNight();
}

// ── State transitions ─────────────────────────────────────────────────────────

function _transitionToDay() {
  // Clover luck accumulation — read hotbar before incrementing wave number
  addNightLuck(hotbar);

  waveState.waveNumber++;
  if (waveState.waveNumber > waveState.highestWave) {
    waveState.highestWave = waveState.waveNumber;
  }
  waveState.state      = WaveState.DAY;
  waveState.stateTimer = 0;

  // Resize the arena for this wave number
  setWaveMapForWave(waveState.waveNumber);

  // Plan the upcoming night mob queue during day phase so we can read
  // the actual highest rarity tier that will spawn (not just what could spawn).
  _planNight(waveState.waveNumber);

  // Dominant rarity: highest tier present in the planned spawn queue.
  const highestTier = waveState.spawnQueue.reduce((max, entry) => Math.max(max, entry.tier), 0);
  waveState.dominantRarity     = highestTier;
  waveState.dominantRarityName = RARITY_WAVE_CONFIG[highestTier]?.name ?? 'Common';
}

// True while the boss is in its 3s pre-spawn delay (prevents premature night end)
let _bossSpawnPending = false;

function _transitionToNight() {
  waveState.state       = WaveState.NIGHT;
  waveState.stateTimer  = 0;
  waveState.nightTimer  = 0;
  waveState.spawnedMobs = 0;
  waveState.burstTimer  = 0;
  _bossSpawnPending     = false;
  // trackedMobIds already cleared inside _planNight

  // Boss roll — if a boss spawns this night, NO regular mobs spawn (boss-only night)
  const bossEntry = rollBossSpawn(waveState.waveNumber);
  if (bossEntry && _spawnCallback) {
    // Clear the regular mob queue — boss night has only the boss
    waveState.spawnQueue    = [];
    waveState.totalMobs     = 0;
    waveState.spawnedMobs   = 0;
    _bossSpawnPending       = true;
    spawnBoss(
      bossEntry.typeId,
      bossEntry.tier,
      _spawnCallback,
      (mobId) => {
        _bossSpawnPending = false;
        waveState.trackedMobIds.add(mobId);
      }
    );
  }
}

function _updateDay(dt) {
  waveState.stateTimer += dt;
  if (waveState.stateTimer >= DAY_DURATION_MS) {
    _transitionToNight();
  }
}

function _updateNight(dt) {
  waveState.stateTimer += dt;
  waveState.nightTimer += dt;

  // Trickle spawning — spread mobs over TRICKLE_WINDOW_MS
  if (waveState.spawnedMobs < waveState.totalMobs) {
    waveState.burstTimer -= dt;
    if (waveState.burstTimer <= 0) {
      waveState.burstTimer = waveState.burstInterval;
      _spawnBurst();
    }
  }

  // Clear condition: all mobs spawned AND all living tracked mobs dead AND no boss pre-spawning
  const allSpawned = waveState.spawnedMobs >= waveState.totalMobs;
  const allDead    = waveState.trackedMobIds.size === 0;
  if (allSpawned && allDead && !_bossSpawnPending) {
    _transitionToDay();
  }
}

// ── Night planning ────────────────────────────────────────────────────────────

// Garden biome mob pool — expand with more biomes later
const GARDEN_MOB_TYPES = ['bee', 'ladybug', 'spider', 'hornet', 'centipede_head'];

function _planNight(wave) {
  const count = getMobCountForWave(wave);
  waveState.totalMobs = count;
  waveState.trackedMobIds.clear();
  waveState.spawnQueue = [];

  for (let i = 0; i < count; i++) {
    if (Math.random() < STRUCTURE_SPAWN_CHANCE) {
      const typeId = Math.random() < 0.5 ? 'beehive' : 'ant_hole';
      const tier   = rollRarity(wave);
      waveState.spawnQueue.push({ typeId, tier, isStructure: true });
    } else {
      const tier   = rollRarity(wave);
      const typeId = GARDEN_MOB_TYPES[Math.floor(Math.random() * GARDEN_MOB_TYPES.length)];
      waveState.spawnQueue.push({ typeId, tier, isStructure: false });
    }
  }

  // Spread all mobs over TRICKLE_WINDOW_MS
  const numBursts = Math.ceil(count / TRICKLE_BURST);
  waveState.burstInterval = TRICKLE_WINDOW_MS / Math.max(1, numBursts);
  waveState.burstTimer    = 0;
}

function _spawnBurst() {
  const spawnCount = Math.min(TRICKLE_BURST, waveState.totalMobs - waveState.spawnedMobs);
  for (let i = 0; i < spawnCount; i++) {
    const entry = waveState.spawnQueue[waveState.spawnedMobs];
    if (!entry) break;
    waveState.spawnedMobs++;
    if (_spawnCallback) {
      const mobId = _spawnCallback(entry.typeId, entry.tier, entry.isStructure);
      if (mobId != null) waveState.trackedMobIds.add(mobId);
    }
  }
}