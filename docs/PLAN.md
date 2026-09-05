# Omarchy Pilot — build plan

**Status: living document.** It records what we decided and why, so the
reasoning is not lost between sessions. Update it when a decision changes.
Anything marked OPEN is not yet decided.

Last updated: 2026-09-05.

---

## 1. What this is

An Omarchy status-bar plugin showing aviation weather for **one** aerodrome:
its METAR, its TAF, and a flight-category label.

The presentation follows [metar-taf.com](https://metar-taf.com/), reduced to
what fits a 500 x 600 px popup panel.

### Decisions taken

| Decision | Choice |
|---|---|
| Bar pill | ICAO plus the category, in the category colour |
| Fourth category | LIFR, the standard term |
| TAF depth | Decoded, with an hour-by-hour timeline |
| Placement | Beside the existing weather pill, not replacing it |
| Repository | `~/Projects/omarchy-pilot`, independent of this machine |
| Plugin id | `pilot.metar` |
| Licence | MIT |
| Publishing | Local only until it works |

---

## 2. Packaging

Omarchy already has a distribution mechanism, and reading its source settled
the repository layout:

```
omarchy plugin add <git-url>
  → git clone <url> <staging>
  → omarchy-plugin-validate <staging>
  → mv <staging> ~/.config/omarchy/plugins/<manifest id>
```

**The repository is the plugin.** Three rules follow, and each one is
enforced by `omarchy-plugin-validate`:

1. `manifest.json` must sit at the repository root.
2. No symlink anywhere inside, except under `.git`.
3. The id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and must not start with
   `omarchy.`, which is reserved.

One repository therefore ships exactly one plugin id. A later `pilot.notam`
needs its own repository.

`omarchy plugin update` does a `git pull` in place, so a user who installed
from git gets updates with no extra tooling.

### Install

```bash
omarchy plugin add https://github.com/mittsh/omarchy-pilot.git --enable
omarchy bar set pilot.metar icao EETN
```

### Development

`dev/sync.sh` copies the working tree into the plugins directory. It copies
rather than links, because a symlink fails validation, and because a copy is
what a real user gets.

```bash
dev/sync.sh              # after a .qml change
dev/sync.sh --restart    # after a .js change
```

The `--restart` distinction is not optional. `rescanPlugins` clears the QML
component cache but **not** the JavaScript resource cache, so a change to a
`.js` file is invisible until the shell restarts. This cost us an hour on the
weather pill before we understood it.

---

## 3. Data source

One request returns both products, with no key and no registration:

```
GET https://aviationweather.gov/api/data/metar?ids=EETN&format=raw&taf=true
User-Agent: omarchy-pilot/<version> (<contact>)
```

Limit is 100 requests per minute. A 10-minute poll of one station uses about
0.1% of it.

### Why raw text, not the decoded JSON

The API offers decoded JSON. We do not use it.

1. **It is lossy outside the United States.** EETN reports `9999`, meaning 10
   km or more. The JSON returns `"visib":"6+"` in statute miles, and `CAVOK`
   disappears entirely. For a European user that is the wrong answer, and it
   cannot be recovered from the JSON.
2. **The fallbacks are raw only.** Raw-first means all three sources feed one
   code path.
3. METAR is a small, closed, standardised grammar. A correct decoder for the
   groups a status bar shows is a few hundred lines.

### Fallback order

| Rank | Source | Notes |
|---|---|---|
| 1 | `aviationweather.gov/api/data` | Both products, one request |
| 2 | `tgftp.nws.noaa.gov/data/.../<ICAO>.TXT` | Two requests. Different host and stack, so it survives an API outage. Strip the date line and the duplicated `TAF TAF` token |
| 3 | `api.met.no/weatherapi/tafmetar/1.0/` | Keyless, CC BY 4.0, about 4000 airports. Returns 24 hours per call, so use it last. Requires an identifying User-Agent and attribution |

Rejected: CheckWX and AVWX both need registration; Ogimet is scraped HTML
with no usage policy.

### Behaviour to handle

- An unknown ICAO code returns **HTTP 204 with an empty body**, not 404.
- NOAA blocks unidentified automated traffic. Always send the User-Agent.
- Undocumented query parameters return 400. Do not invent any.
- Use HTTPS and the bare hostname, never the `www` subdomain.

---

## 4. Files

```
omarchy-pilot/
├── manifest.json      Plugin manifest. Must stay at the root
├── Panel.qml          Bar pill, popup, fetch, timers
├── Metar.js           METAR decoder            DONE
├── Theme.js           Palette resolution       DONE
├── Category.js        Flight category rules    BLOCKED, see section 5
├── Taf.js             TAF decoder and timeline TO DO
├── dev/sync.sh        Development install
├── docs/PLAN.md       This file
└── tests/             node tests, no framework
```

Every `.js` file is pure: no clock, no network, no QML types. The caller
passes the current time in. That makes the whole decoder testable under
`node` and keeps the tests deterministic. The trailing `module.exports` block
is invisible to QML, where `module` is undefined.

---

## 5. Flight category — OPEN

The FAA scheme is settled and is what US sources return:

| Category | Ceiling | Visibility |
|---|---|---|
| VFR | over 3000 ft | **and** over 5 sm (8 km) |
| MVFR | 1000 to 3000 ft | **or** 3 to 5 sm |
| IFR | 500 to 1000 ft | **or** 1 to 3 sm |
| LIFR | below 500 ft | **or** below 1 mile |
| UNKN | data missing or stale | |

The category is the **worse** of the two values. A ceiling is the lowest
BKN, OVC or VV layer.

**OPEN: what a European aerodrome should show.** Research is running on
whether EASA or ICAO defines any equivalent, whether MVFR and LIFR are used
in Europe at all, and whether the ICAO prefix is a sound way to pick the rule
set. `Category.js` is not written until that reports, because the answer
decides its shape.

**Out of scope: GAFOR.** The General Aviation Forecast route-sector scheme is
too specific for this plugin. It covers route sectors rather than an
aerodrome, it exists only in a few countries, and it needs a different data
source. Decided 2026-09-05.

Two things are already settled regardless of the outcome:

- The badge always prints its category as **text**. Colour is reinforcement,
  never the only channel — see section 7.
- Visibility and ceiling are each coloured by their own category, so the
  reader sees which of the two is driving the result. This is the best idea
  on metar-taf.com and it costs nothing.

---

## 6. Panel layout

```
┌────────────────────────────────────────────────┐
│ EETN  Lennart Meri Tallinn         [   VFR   ] │  header, filled chip
│ 12:50 LT · 17m old                             │  age is a first-class field
├────────────────────────────────────────────────┤
│ Wind        ↖ 310° (270-360°)          4 kt    │
│ Visibility  10 km+                             │  coloured by its own band
│ Clouds      FEW 3,000 ft CB                    │
│ Ceiling     None                               │  coloured by its own band
│ Temp/Dew    16 °C / 10 °C                      │
│ Humidity    68%                                │
│ QNH         995 hPa                            │
├────────────────────────────────────────────────┤
│ METAR EETN 050950Z 31004KT 270V360 9999        │  raw, monospace
│ FEW030CB 16/10 Q0995 NOSIG                     │
├────────────────────────────────────────────────┤
│ 09 ████████████▒▒▒▒▒▒░░░░░░████████████ 09     │  one block per hour
│                ▲ now                           │
│ 0506/0606 VRB02KT 9999 SCT025                  │  raw TAF, one line per group
│ TEMPO 0506/0509 BKN004 FEW020CB                │  dotted marks TEMPO or PROB
└────────────────────────────────────────────────┘
```

### Taken from metar-taf.com

- The category badge, as a filled chip.
- **Observation age.** A METAR is only as good as its age. Amber past 40
  minutes, red past 90.
- Per-field colouring of visibility and ceiling.
- The raw METAR, quarantined in a monospace box. Pilots read raw.
- Value large, label small, units welded to the value: `4 kt`, not
  `Wind speed: 4 (knots)`. Their exact strings: `10 km+`, `None`, `995 hPa`,
  `310° (270-360°)`.
- The TAF hour strip, coloured by category. It answers "when does it go bad"
  in one glance.
- `TEMPO` and `PROB` shown as a dotted or dashed treatment, never a colour,
  so probability stays orthogonal to category.

### Dropped

Their wind compass, cloud altitude diagram, four sparklines and prose
decoder. Each needs more width than the whole panel has. The prose exists on
their site for search engines; we have no such need.

The full TAF grid is dropped too. Eight rows by 24 hours will not fit. Only
the category row survives.

---

## 7. Theming

Everything binds to `Color.*` and `Style.*`. Those are singleton properties
reassigned on a theme switch, so bindings re-evaluate with no plugin code and
the panel inherits the shell's 420 ms cross-fade.

Take the foreground from the injected `bar` where it exists:
`bar ? bar.foreground : Color.foreground`.

### The reload trap

`Color` exposes no green, blue or magenta, so the plugin reads the theme's
`colors.toml` itself. **A `FileView` watch on that file does not work.**
`omarchy-theme-set` does `rm -rf` on the theme directory and then `mv`s a new
one in, so the watch fires on the delete and the view is left permanently
failed. Omarchy hit the same wall and takes the new theme over IPC instead,
which a plugin cannot receive.

Watch `~/.local/state/omarchy/current/theme.name` instead. It is rewritten in
place with `echo >`, so the inode survives, and it changes after the
directory swap.

```qml
FileView {                                    // the palette
  path: Color.currentThemePath + "/colors.toml"
  watchChanges: false                         // the directory is swapped
}
FileView {                                    // the trigger
  path: Color.home + "/.local/state/omarchy/current/theme.name"
  watchChanges: true
  onFileChanged: reload()
  onLoaded: colorsFile.reload()
}
```

### Three things that would each break the badge

| Problem | Real example | Handling |
|---|---|---|
| Two disjoint file formats | A theme generated from an alacritty config has only `color0..color15` | Both key sets parsed |
| Duplicate palette entries | `retro-82` blue equals magenta; `matte-black` red equals magenta | Fixed resolve order, collision walks the chain |
| Five of 22 themes are light | White on flexoki-light's background is 1.02:1 | Label picked by luminance |

### Legibility

Measured across 22 themes and 4 colours:

| Scheme | Worst contrast |
|---|---|
| **Black or white by luminance** | **4.66:1**, clears WCAG AA |
| Forced white | 2.64:1 |
| Coloured text on the panel background | 2.30:1 |

So the badge is a filled chip, never coloured text. `Color.muted` is banned:
it falls below 2.0:1 against the background in eight themes.

Six themes are effectively monochrome, which is why the category is always
printed as text.

### Fonts

`Style.font.family` is the fontconfig alias `"monospace"`, not a real family.
Bind to it, for body text **and** for the raw METAR block. Never the literal
`"monospace"`, and never `Style.font.resolvedFamily`, which freezes the
family at whatever `fc-match` last returned.

The font follows a separate setting, not the theme. The font *size* does
follow the theme, through `base-size` in `shell.toml`.

---

## 8. Configuration

Omarchy's `settingsForm` manifest field is a **dead hook** in this build.
`schema` and `defaults` are stored and read by nothing, and no settings UI
exists. A plugin cannot declare its own form.

So the ICAO code is set two ways, both writing the same place:

```bash
omarchy bar set pilot.metar icao EETN
```

and a text field inside the panel, saved with
`bar.shell.updateEntryInline(moduleName, entry)`. The value lands in
`shell.json` beside the widget id, which is how the clock plugin does it.

**Nearest aerodrome** is resolved once, with a bounding-box query against
`/api/data/stationinfo`, then written into the config as a concrete ICAO
code. No station database is bundled and no lookup repeats.

---

## 9. Format traps

Each of these fails **silently**. The report still renders; it just lies.
All are handled and tested.

| Trap | Example | Consequence if missed |
|---|---|---|
| Wind in metres per second | `ULLI 29005MPS` | Wind reads half the truth |
| Pressure unit | `Q0995` against `A2982` | Wrong QNH |
| Visibility unit | `9999`, `10SM`, `1/2SM` | Wrong category |
| `CAVOK` | Replaces visibility, cloud **and** weather | Panel shows nothing |
| Cloud base `///` | `BKN///` in fog | A zero ceiling and a false LIFR |
| `//` alone | Automatic station, no weather sensor | Unparsed group |
| Six digits after a runway | `R28R/090065` | It is runway **state**, not RVR |
| US remark block | `T02220156` | Loses the tenth of a degree |

---

## 10. Phases

| # | Work | State |
|---|---|---|
| 1 | `Metar.js` and tests | **Done.** 20 tests. 40 live aerodromes, no unknown groups |
| 2 | `Theme.js` and tests | **Done.** 14 tests. All 22 installed themes swept |
| 3 | `Category.js` and tests | **Blocked** on the EASA question |
| 4 | Skeleton plugin, pill on the bar | To do |
| 5 | Panel decoded rows and raw box | To do |
| 6 | `Taf.js` and tests | To do |
| 7 | Timeline strip | To do |
| 8 | ICAO field, nearest lookup, fallbacks | To do |
| 9 | `tests/all.sh`, README, first push | To do |

Phases 1, 2, 3 and 6 need no running shell.

### Testing

There is no plugin test harness in Omarchy. The pattern comes from the
`b.omadoro` plugin already on this machine: plain `node` with
`node:assert/strict`, no framework, plus `omarchy plugin validate`, plus a
runtime smoke test that boots a throwaway Quickshell in a temporary `HOME`
and asserts over IPC.

That technique extends to theme testing, with one correction:
`Color.currentThemePath` is built from `HOME`, and **ignores
`XDG_STATE_HOME`**. Stage a test theme at
`$test_home/.local/state/omarchy/current/theme`.

`qmllint` is not installed on this machine, so that stage will skip.

---

## 11. Open questions

1. **The European category scheme.** Section 5. Research running.
2. **Aerodrome name quality.** The API calls EETN "Tallin Arpt", misspelled
   and abbreviated. Options: accept it, allow a `name` override key, or
   generate a name table from OurAirports at build time. Deferred until the
   panel exists.
3. **Whether to publish.** The repository is local until it works.
