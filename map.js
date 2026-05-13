/**
 * LevelHUD.js — top-left in-game status HUD
 *
 * Layout:
 *
 *   [● flower ●]  [██████████░░░  HP  ]
 *                    [████░░░  Lvl N  ]   ← narrower, centered under HP
 */

import { drawFlowerFaceParams, circle } from './renderer.js';
import { mousePos }                      from './ui.js';
import { inputState }                    from './inputState.js';
import { player, isMoving }              from './player.js';
import {
  levelFromXp,
  xpForLevel,
  totalXpForLevel,
} from './leveling.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function fmt(n) {
  n = Math.max(0, Math.floor(n));
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────
// Cog: top 16 + height 54 + border 3 = 73px bottom. We sit 17px below that.

const PAD_X    = 12;         // HUD left edge
const PAD_Y    = 92;         // HUD top edge (flower top)

const FLOWER_R = 28;         // flower body radius
const GAP      = 8;          // gap between flower right edge and pill left edge

// HP pill
const HP_W     = 150;
const HP_H     = 24;
// LVL pill — narrower, centered under HP pill
const LVL_W    = 116;
const LVL_H    = 18;
const PILL_GAP = 4;          // gap between HP pill and Lvl pill

// Derived positions (computed at module load, constants so minifier-friendly)
const FLOWER_CX = PAD_X + FLOWER_R;                // flower center x
const FLOWER_CY = PAD_Y + FLOWER_R;                // flower center y
const PILL_X    = PAD_X + FLOWER_R * 2 + GAP;     // left edge of both pills

// HP bar: center sits 6px below flower center ("slightly under")
const HP_Y      = FLOWER_CY - HP_H / 2 + 6;
// LVL bar: directly below HP, centered horizontally under it
const LVL_Y     = HP_Y + HP_H + PILL_GAP;
const LVL_X     = PILL_X + (HP_W - LVL_W) / 2;

// Colours
const HP_BG    = '#2a2a2a';
const HP_FILL  = '#75dd34';
const LVL_BG   = '#2a2a2a';
const LVL_FILL = '#e2eb67';

// ─────────────────────────────────────────────────────────────────────────────
// LevelHUD class
// ─────────────────────────────────────────────────────────────────────────────

class LevelHUD {
  constructor() {
    this.xp         = 0;
    this.level      = 0;
    this._renderXp  = 0;
    this._renderHp  = 0;
    this._initAnim  = 0;

    // Face state — mirrors renderer's face object exactly
    this._attackT     = 0;
    this._defendT     = 0;
    this._hudEyeAngle = 0;

    this._ready = false;
  }

  init(xp = 0) {
    this.xp        = xp;
    this.level     = Math.floor(levelFromXp(xp));
    this._renderXp = xp;
    this._ready    = true;
    this._initAnim = 0;
  }

  addXp(amount) {
    this.xp    = Math.max(0, this.xp + amount);
    this.level = Math.floor(levelFromXp(this.xp));
  }

  // ── Main draw ──────────────────────────────────────────────────────────────
  draw(ctx, W, H, dt, playerHp, maxHp) {
    if (!this._ready) return;

    // Slide-in from above on init/respawn
    this._initAnim = lerp(this._initAnim, 1, 0.055);
    const slideY   = (1 - this._initAnim) * -130;

    ctx.save();
    ctx.translate(0, slideY);

    // Smooth interpolation
    const spd      = Math.min(1, 0.07 * (dt / 16));
    this._renderXp = lerp(this._renderXp, this.xp,   spd);
    this._renderHp = lerp(this._renderHp, playerHp,  spd * 1.4);

    // ── Face expression + eye-direction state ────────────────────────────────
    const FACE_SPD = 0.012;
    const fk = 1 - Math.pow(1 - FACE_SPD, dt);

    this._attackT += ((inputState.expand  ? 1 : 0) - this._attackT) * fk;
    this._defendT += ((inputState.retract ? 1 : 0) - this._defendT) * fk;

    if (isMoving) {
      let da = player.moveAngle - this._hudEyeAngle;
      while (da >  Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      this._hudEyeAngle += da * fk;
    }

    // ── Flower ──────────────────────────────────────────────────────────────
    this._drawFlower(ctx);

    // ── HP pill ─────────────────────────────────────────────────────────────
    const hpPct   = Math.max(0, Math.min(1, this._renderHp / maxHp));
    const adjMy   = mousePos.y - slideY;
    const hoverHp = this._isOver(mousePos.x, adjMy, PILL_X, HP_Y, HP_W, HP_H);
    const hpLabel = hoverHp
      ? `${fmt(playerHp)} / ${fmt(maxHp)} HP`
      : `${fmt(this._renderHp)} / ${fmt(maxHp)} HP`;
    this._drawPill(ctx, PILL_X, HP_Y, HP_W, HP_H, hpPct, HP_FILL, HP_BG, hpLabel, 13);

    // ── Level / XP pill ─────────────────────────────────────────────────────
    const contLvl  = levelFromXp(this._renderXp);
    const intLvl   = Math.floor(contLvl);
    const xpFrac   = contLvl % 1;
    const xpStart  = totalXpForLevel(intLvl);
    const xpEnd    = xpStart + xpForLevel(intLvl + 1);
    const hoverLvl = this._isOver(mousePos.x, adjMy, LVL_X, LVL_Y, LVL_W, LVL_H);
    const lvlLabel = hoverLvl
      ? `${fmt(this.xp)} / ${fmt(xpEnd)} XP`
      : `Lvl ${intLvl + 1}`;
    this._drawPill(ctx, LVL_X, LVL_Y, LVL_W, LVL_H, xpFrac, LVL_FILL, LVL_BG, lvlLabel, 11);

    ctx.restore();
  }

  // ── Flower draw ─────────────────────────────────────────────────────────────
  _drawFlower(ctx) {
    // Draw body with NO shadow — shadow would darken the body canvas pixels,
    // causing the eyebrow triangle (drawn by drawFlowerFaceParams without shadow)
    // to appear a different color even though both are #ffe840 / player.color.
    // The world renderer also draws the player body without shadow.
    circle(ctx, FLOWER_CX, FLOWER_CY, FLOWER_R,
      player.color,   // '#ffe840'  — same as world
      player.border,  // '#f0c800'  — visible golden stroke, matches world exactly
      3, 1);

    // Face: move-direction eyes + attack/defend expressions, same as world
    drawFlowerFaceParams(ctx, FLOWER_CX, FLOWER_CY, FLOWER_R,
      this._attackT, this._defendT, this._hudEyeAngle, 1);
  }

  // ── Pill draw ───────────────────────────────────────────────────────────────
  _drawPill(ctx, x, y, w, h, fraction, fillColor, bgColor, label, fontSize) {
    const r  = h / 2;
    const pd = 3;
    const iw = w - pd * 2;
    const ih = h - pd * 2;
    const ir = ih / 2;

    ctx.save();

    // Background pill
    ctx.shadowColor   = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur    = 5;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.shadowColor = 'transparent';

    // Subtle inner border ring
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.stroke();

    // Fill bar — clipped to inner pill shape
    if (fraction > 0.001) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x + pd, y + pd, iw, ih, ir);
      ctx.clip();
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(x + pd, y + pd, Math.max(ir * 2, fraction * iw), ih, ir);
      ctx.fill();
      ctx.restore();
    }

    // Label
    ctx.font         = `900 ${fontSize}px "UbuntuCustom","Ubuntu",Arial,sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const lx = x + w / 2, ly = y + h / 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.80)';
    ctx.lineWidth   = 2.5;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillText(label, lx, ly);

    ctx.restore();
  }

  _isOver(mx, my, rx, ry, rw, rh) {
    return mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh;
  }
}

export const levelHUD = new LevelHUD();
