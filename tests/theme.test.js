// Theme palette tests.
//
//   node tests/theme.test.js
//
// The fixtures are copied verbatim from real Omarchy themes, so the awkward
// cases stay covered even when the tests run on a machine with no Omarchy
// installed. The sweep at the end reads every installed theme and skips
// itself when there are none.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const T = require("../Theme.js")

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed++
  } catch (error) {
    console.error(`FAIL  ${name}`)
    console.error(error.message)
    process.exitCode = 1
  }
}

// The four Color singleton properties the shell guarantees under both theme
// file shapes. In practice the caller reads these off Color.*.
function fallbacksFor(palette) {
  return {
    foreground: palette.foreground || "#cacccc",
    background: palette.background || "#101315",
    accent: palette.accent || palette.color4 || "#cacccc",
    // Color.urgent is the theme's red or color1, per Commons/Color.qml.
    urgent: palette.red || palette.color1 || "#a55555",
    muted: palette.muted || "#707880"
  }
}

const CATEGORIES = ["vfr", "mvfr", "ifr", "lifr"]
const AA = 4.5

function assertUsable(colors, palette, label) {
  const seen = new Set()
  for (const category of CATEGORIES) {
    const fill = colors[category]
    assert.ok(/^#[0-9a-f]{6}$/.test(fill), `${label}: ${category} is not a hex colour, got ${fill}`)
    assert.ok(!seen.has(fill), `${label}: ${category} duplicates another category at ${fill}`)
    seen.add(fill)

    const ratio = T.contrast(T.labelOn(fill), fill)
    assert.ok(ratio >= AA,
      `${label}: ${category} label contrast ${ratio.toFixed(2)} is below ${AA} on ${fill}`)
  }
}

// ------------------------------------------------------------------ parsing

test("parses the flat key = \"#hex\" form", () => {
  const palette = T.parseColorsToml(`
mode = "dark"
accent = "#7aa2f7"
background = "#1a1b26"
red = "#f7768e"
`)
  assert.equal(palette.accent, "#7aa2f7")
  assert.equal(palette.red, "#f7768e")
  assert.equal(palette.mode, undefined, "a non-hex value is not a colour")
})

test("ignores the values that are not plain six-digit hex", () => {
  // Real lines from shipped themes. None of them is a badge colour.
  const palette = T.parseColorsToml(`
mode = "light"
hyprland_active_border = "rgba(26a269ee) rgba(2ec27eee) 45deg"
hyprland_inactive_border = "rgb(1e1e1e)"
green = "#879A39"
`)
  assert.deepEqual(Object.keys(palette), ["green"])
  assert.equal(palette.green, "#879a39", "hex is normalised to lower case")
})

test("survives an empty or missing file", () => {
  assert.deepEqual(T.parseColorsToml(""), {})
  assert.deepEqual(T.parseColorsToml(null), {})
})

// -------------------------------------------------------------- the maths

test("luminance and contrast match known WCAG values", () => {
  assert.equal(T.luminance("#000000"), 0)
  assert.equal(T.luminance("#ffffff"), 1)
  assert.equal(Math.round(T.contrast("#ffffff", "#000000") * 100) / 100, 21)
})

test("the label flips from white to black on a bright fill", () => {
  assert.equal(T.labelOn("#1a1b26"), "#ffffff")
  assert.equal(T.labelOn("#ffc107"), "#000000")
})

// ------------------------------------------------- the awkward real themes

test("tokyo-night: the ordinary case", () => {
  const palette = {
    mode: "dark", accent: "#7aa2f7", muted: "#414868",
    background: "#1a1b26", foreground: "#a9b1d6",
    red: "#f7768e", green: "#9ece6a", blue: "#7aa2f7", magenta: "#ad8ee6",
    bright_magenta: "#bb9af7"
  }
  const colors = T.badgeColors(palette, fallbacksFor(palette))
  assert.equal(colors.vfr, "#9ece6a")
  assert.equal(colors.mvfr, "#7aa2f7")
  assert.equal(colors.ifr, "#f7768e")
  assert.equal(colors.lifr, "#ad8ee6")
  assertUsable(colors, palette, "tokyo-night")
})

test("retro-82: blue and magenta are the same colour in the theme", () => {
  const palette = {
    mode: "dark", accent: "#faa968", muted: "#2a6b78",
    background: "#05182e", foreground: "#f6dcac",
    red: "#f85525", green: "#028391", blue: "#3f8f8a", magenta: "#3f8f8a",
    bright_magenta: "#3f8f8a", bright_blue: "#faa968"
  }
  const colors = T.badgeColors(palette, fallbacksFor(palette))
  assert.equal(colors.mvfr, "#3f8f8a", "blue is resolved first and keeps it")
  assert.notEqual(colors.lifr, colors.mvfr, "magenta must not collide with blue")
  assertUsable(colors, palette, "retro-82")
})

test("matte-black: red and magenta are the same colour in the theme", () => {
  const palette = {
    mode: "dark", accent: "#e68e0d", muted: "#333333",
    background: "#121212", foreground: "#bebebe",
    red: "#d35f5f", green: "#ffc107", blue: "#e68e0d", magenta: "#d35f5f",
    bright_magenta: "#b91c1c", bright_red: "#b91c1c"
  }
  const colors = T.badgeColors(palette, fallbacksFor(palette))
  assert.equal(colors.ifr, "#d35f5f", "red is resolved before magenta")
  assert.notEqual(colors.lifr, colors.ifr)
  assertUsable(colors, palette, "matte-black")
})

test("catppuccin-latte: a light theme", () => {
  const palette = {
    mode: "light", accent: "#1e66f5", muted: "#acb0be",
    background: "#eff1f5", foreground: "#4c4f69",
    red: "#d20f39", green: "#40a02b", blue: "#1e66f5", magenta: "#ea76cb"
  }
  assert.equal(T.isLight(palette.background), true)
  const colors = T.badgeColors(palette, fallbacksFor(palette))
  assertUsable(colors, palette, "catppuccin-latte")
  // Forcing white here would give 2.64:1 on the magenta chip.
  assert.equal(T.labelOn(colors.lifr), "#000000")
})

test("solitude: an almost monochrome theme still yields four distinct fills", () => {
  const palette = {
    mode: "dark", accent: "#798186", muted: "#4b4e55",
    background: "#101315", foreground: "#cacccc",
    red: "#565d60", green: "#9fa5a9", blue: "#798186", magenta: "#aeaeae",
    bright_magenta: "#9a9a9a"
  }
  const colors = T.badgeColors(palette, fallbacksFor(palette))
  assertUsable(colors, palette, "solitude")
})

test("a generated theme has only color0..color15", () => {
  // omarchy-theme-colors-from-alacritty emits this shape for a third-party
  // theme that ships only an alacritty config. There is no red, green, blue
  // or magenta key at all.
  const palette = {
    accent: "#7aa2f7", selection: "#292e42",
    background: "#1a1b26", foreground: "#a9b1d6",
    color0: "#15161e", color1: "#f7768e", color2: "#9ece6a", color3: "#e0af68",
    color4: "#7aa2f7", color5: "#bb9af7", color6: "#7dcfff", color7: "#a9b1d6"
  }
  const colors = T.badgeColors(palette, fallbacksFor(palette))
  assert.equal(colors.vfr, "#9ece6a", "green comes from color2")
  assert.equal(colors.mvfr, "#7aa2f7", "blue comes from color4")
  assert.equal(colors.ifr, "#f7768e", "red comes from color1")
  assert.equal(colors.lifr, "#bb9af7", "magenta comes from color5")
  assertUsable(colors, palette, "generated")
})

test("an empty palette still produces four usable fills", () => {
  // The worst case: a theme file that failed to load entirely. The plugin
  // must still render rather than paint nothing.
  const colors = T.badgeColors({}, {
    foreground: "#cacccc", background: "#101315",
    accent: "#cacccc", urgent: "#a55555"
  })
  assertUsable(colors, {}, "empty")
})

test("the badge always carries its band as text", () => {
  // Six shipped themes are monochrome or have duplicate palette entries, so
  // colour can never be the only channel.
  const fallbacks = { foreground: "#cacccc", background: "#101315", accent: "#7aa2f7", urgent: "#a55555" }
  const lifr = T.badge("lifr", "LIFR", {}, fallbacks, T.SCHEME_SLOTS.faa)
  assert.equal(lifr.text, "LIFR")
  assert.ok(lifr.fill)
  assert.ok(lifr.label)

  // The slot and the printed text differ under SERA: the amber band is the
  // "svfr" colour slot but prints "SVFR", and the green slot prints "VMC".
  const vmc = T.badge("vfr", "VMC", { green: "#9ece6a" }, fallbacks, T.SCHEME_SLOTS.sera)
  assert.equal(vmc.text, "VMC")
  assert.equal(vmc.fill, "#9ece6a")
})

test("a scheme resolves only the slots it shows", () => {
  const palette = { green: "#9ece6a", yellow: "#e0af68", red: "#f7768e", blue: "#7aa2f7", magenta: "#ad8ee6" }
  const sera = T.badgeColors(palette, fallbacksFor(palette), T.SCHEME_SLOTS.sera)
  assert.deepEqual(Object.keys(sera).sort(), ["ifr", "svfr", "vfr"])
  const faa = T.badgeColors(palette, fallbacksFor(palette), T.SCHEME_SLOTS.faa)
  assert.deepEqual(Object.keys(faa).sort(), ["ifr", "lifr", "mvfr", "vfr"])
})

// -------------------------------------------- every theme installed locally

test("every installed Omarchy theme yields four distinct, legible fills", () => {
  const roots = ["/usr/share/omarchy/themes", `${process.env.HOME}/.config/omarchy/themes`]
  let checked = 0

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    for (const name of fs.readdirSync(root)) {
      const file = path.join(root, name, "colors.toml")
      if (!fs.existsSync(file)) continue
      const palette = T.parseColorsToml(fs.readFileSync(file, "utf8"))
      assertUsable(T.badgeColors(palette, fallbacksFor(palette)), palette, name)
      checked++
    }
  }

  if (checked === 0) console.log("  (no themes installed, sweep skipped)")
  else console.log(`  (swept ${checked} installed themes)`)
})

console.log(`theme.test.js: ${passed} passed`)
