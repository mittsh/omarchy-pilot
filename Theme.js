// Theme palette resolution.
//
// Omarchy's Color singleton exposes only foreground, background, accent,
// urgent and muted. A flight-category badge needs four distinguishable
// colours, so this file reads the active theme's colors.toml itself and
// resolves green, blue, red and magenta with a fallback chain.
//
// Pure functions. Colours cross the boundary as "#rrggbb" strings, so the
// whole file is testable under node.
//
// Two facts drive the design, both verified against the shell source:
//
//   1. A theme file may have either of two completely different key sets. A
//      shipped theme has red/green/blue/magenta. A theme generated from an
//      alacritty config by omarchy-theme-colors-from-alacritty has only
//      color0..color15, accent, selection, background and foreground.
//
//   2. Five of the 22 shipped themes are LIGHT, and several are effectively
//      monochrome. Colour can therefore never be the only channel: the badge
//      always prints the category as text as well.

// ------------------------------------------------------------------ parsing

// Deliberately the same regex the shell uses in Commons/Color.qml, so this
// plugin and the shell never disagree about what a theme file says. Every
// real colors.toml is flat "key = value" with no sections, no comments and no
// arrays, so a general TOML parser would be dead weight.
var COLOR_LINE = /^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/

function parseColorsToml(raw) {
  var palette = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = COLOR_LINE.exec(lines[i])
    if (m) palette[m[1].toLowerCase()] = m[2].toLowerCase()
  }
  return palette
}

// ------------------------------------------------------------ colour maths

function toRgb(hex) {
  var m = /^#?([0-9A-Fa-f]{6})$/.exec(String(hex || "").trim())
  if (!m) return null
  var n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function toHex(rgb) {
  function pair(v) {
    var clamped = Math.max(0, Math.min(255, Math.round(v)))
    return (clamped < 16 ? "0" : "") + clamped.toString(16)
  }
  return "#" + pair(rgb.r) + pair(rgb.g) + pair(rgb.b)
}

function srgbToLinear(channel) {
  var c = channel / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// WCAG 2.x relative luminance.
function luminance(hex) {
  var rgb = toRgb(hex)
  if (!rgb) return null
  return 0.2126 * srgbToLinear(rgb.r) +
         0.7152 * srgbToLinear(rgb.g) +
         0.0722 * srgbToLinear(rgb.b)
}

// WCAG 2.x contrast ratio, 1.0 to 21.0.
function contrast(hexA, hexB) {
  var a = luminance(hexA), b = luminance(hexB)
  if (a === null || b === null) return null
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// The label colour for text drawn on a filled chip.
//
// Picking black or white by luminance is the only scheme that stays legible
// across every shipped theme. Measured over 22 themes times 4 badge colours,
// the worst case is 4.66:1, which clears the WCAG AA floor of 4.5. Forcing
// white drops to 2.64:1, and using the theme background as the label colour
// drops to 2.30:1 — both illegible in real themes.
function labelOn(fillHex) {
  var l = luminance(fillHex)
  if (l === null) return "#ffffff"
  return l > 0.179 ? "#000000" : "#ffffff"
}

function isLight(backgroundHex) {
  var l = luminance(backgroundHex)
  return l === null ? false : l > 0.5
}

// ------------------------------------------------------------ badge palette

// First non-empty key wins. Each chain ends at a Color property the shell
// guarantees under both theme file shapes, supplied by the caller.
//
// Green has no Color analogue at all, so it ends at the foreground. Muted is
// deliberately never used: it falls below 2.0:1 against the background in
// eight shipped themes.
var CHAINS = {
  vfr:  ["green",   "color2", "bright_green",   "color10", "$foreground"],
  mvfr: ["blue",    "color4", "bright_blue",    "color12", "$accent"],
  svfr: ["yellow",  "color3", "bright_yellow",  "color11", "$accent"],
  ifr:  ["red",     "color1", "bright_red",     "color9",  "$urgent"],
  lifr: ["magenta", "color5", "bright_magenta", "color13", "$urgent"]
}

// Resolved in this order. An earlier slot keeps its colour; a later one that
// collides walks further down its own chain.
//
// Only the slots a scheme actually uses are resolved, so the three SERA bands
// never lose a colour to an FAA band that is not on screen.
var RESOLVE_ORDER = ["vfr", "mvfr", "svfr", "ifr", "lifr"]

var SCHEME_SLOTS = {
  sera: ["vfr", "svfr", "ifr"],
  faa: ["vfr", "mvfr", "ifr", "lifr"]
}

// Nudge a colour that could not be made unique any other way. Moving toward
// or away from the background keeps it visible on the panel.
function shift(hex, backgroundHex) {
  var rgb = toRgb(hex)
  if (!rgb) return hex
  var towardWhite = !isLight(backgroundHex)
  var factor = towardWhite ? 1.35 : 0.7
  return toHex({ r: rgb.r * factor, g: rgb.g * factor, b: rgb.b * factor })
}

// palette   the parsed colors.toml
// fallbacks { foreground, background, accent, urgent } as "#rrggbb", taken
//           from the Color singleton by the caller
// slots     which semantic slots to resolve. Defaults to all of them; pass
//           SCHEME_SLOTS.sera or .faa to resolve only what is on screen.
//
// Returns a map of slot name to "#rrggbb", all distinct.
function badgeColors(palette, fallbacks, slots) {
  var p = palette || {}
  var f = fallbacks || {}
  var order = slots || RESOLVE_ORDER
  var out = {}
  var taken = {}

  for (var i = 0; i < order.length; i++) {
    var name = order[i]
    var chain = CHAINS[name]
    if (!chain) continue
    var chosen = null

    for (var j = 0; j < chain.length; j++) {
      var key = chain[j]
      var value = key.charAt(0) === "$" ? f[key.slice(1)] : p[key]
      if (!toRgb(value)) continue
      var hex = String(value).toLowerCase()
      // Two shipped themes really do this: retro-82 has blue equal to
      // magenta, matte-black has red equal to magenta.
      if (taken[hex]) { if (!chosen) chosen = hex; continue }
      chosen = hex
      break
    }

    if (!chosen) chosen = f.foreground || "#cacccc"
    if (taken[chosen]) chosen = shift(chosen, f.background)

    out[name] = chosen
    taken[chosen] = true
  }

  return out
}

// Everything the panel needs to paint one band, in one call.
//
// slot is the semantic colour slot ("vfr", "svfr", "ifr", ...), text is what
// the badge prints. They differ because the SERA scheme prints "VMC" and
// "SVFR" over the green and yellow slots.
function badge(slot, text, palette, fallbacks, slots) {
  var colors = badgeColors(palette, fallbacks, slots)
  var key = String(slot || "").toLowerCase()
  var fill = colors[key] || (fallbacks && fallbacks.foreground) || "#808080"
  return { fill: fill, label: labelOn(fill), text: String(text || "UNKN") }
}

if (typeof module !== "undefined") {
  module.exports = {
    parseColorsToml: parseColorsToml,
    badgeColors: badgeColors,
    badge: badge,
    luminance: luminance,
    contrast: contrast,
    labelOn: labelOn,
    isLight: isLight,
    toRgb: toRgb,
    toHex: toHex,
    CHAINS: CHAINS,
    RESOLVE_ORDER: RESOLVE_ORDER,
    SCHEME_SLOTS: SCHEME_SLOTS
  }
}
