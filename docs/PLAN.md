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
| Repository | Its own repository, independent of any one machine |
| Plugin id | `pilot.metar` |
| Licence | MIT |
| Publishing | Public, MIT, under github.com/mittsh |

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

All three are wired and live-verified: each fetches, decodes, and gives the
same answer for EETN. A source that answers with nothing falls through to
the next, so an outage at one does not blank the panel. The panel names the
source when it is not the first, so a degraded fetch is visible.

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
├── Panel.qml          Bar pill, popup, fetch, timers  DONE
├── Metar.js           METAR decoder            DONE
├── Theme.js           Palette resolution       DONE
├── Category.js        Flight category rules    DONE
├── Taf.js             TAF decoder and timeline DONE
├── Format.js          Display strings          DONE
├── Sources.js         The source chain         DONE
├── Stations.js        Bundled aerodrome table  GENERATED
├── dev/build-stations.js  Regenerates the table
├── dev/sync.sh        Development install
├── docs/PLAN.md       This file
└── tests/             node tests, no framework
```

Every `.js` file is pure: no clock, no network, no QML types. The caller
passes the current time in. That makes the whole decoder testable under
`node` and keeps the tests deterministic. The trailing `module.exports` block
is invisible to QML, where `module` is undefined.

---

## 5. Flight category — SETTLED

### There is no EASA equivalent of MVFR and LIFR

A full-text search of the **EASA Easy Access Rules for SERA, August 2025** —
275 pages, the consolidated Regulation (EU) 923/2012 — returns **zero
occurrences of MVFR and zero of LIFR**. Same result in the German met service
decode brochure and in UK CAP 746.

They are a US charting convention, and not regulatory even there. FAA
AC 00-45H: *"These categories are not flight rules ... they were created for
weather charts as a means to visually enhance the products."*

Europe defines a **binary**, VMC or IMC, plus two numeric gates that apply at
an aerodrome and are computable from a METAR. Those gates are the European
rule set.

### The European rule set

| Band | Ceiling | Visibility | Source |
|---|---|---|---|
| **VMC** — VFR | at or above 1500 ft | **and** at or above 5 km | SERA.5005(b) |
| **SVFR** — Special VFR only | at or above 600 ft | **and** at or above 1500 m | SERA.5010(c) |
| **IMC** — IFR only | below that | below that | under the SVFR floor |

Estonia adds nothing of its own. Its AIP ENR 1.2 reads in full: *"Estonia
follows visual flight rules established by the European Commission
Implementing Regulation (EU) No 923/2012."*

The middle band is a real decision at EETN. Tallinn CTR is Class C, so below
1500 ft or 5 km a VFR landing needs a Special VFR clearance from Tallinn
Tower. "MVFR" would be a decision about nothing.

The label says **conditions**, never "flight rules". ForeFlight renamed its
own display for this reason in 2015.

### The FAA rule set, for everywhere else

FAA AIM 7-1-7, verbatim. VFR is the only band using "greater than"; the rest
are "and/or", so the worse of ceiling and visibility wins.

| Band | Ceiling | Visibility |
|---|---|---|
| VFR | over 3000 ft | **and** over 5 sm |
| MVFR | 1000 to 3000 ft | **or** 3 to 5 sm inclusive |
| IFR | 500 to under 1000 ft | **or** 1 to under 3 sm |
| LIFR | under 500 ft | **or** under 1 mile |

Verified against NOAA's own `fltCat` on 28 live US reports: **28 agree, 0
differ**.

### Choosing the rule set

By **ISO 3166-1 country**, never by the ICAO prefix. The prefix is not a
sound proxy for the regulator:

| Prefix trap | Reality |
|---|---|
| `UK` | Ukraine, not the United Kingdom |
| `EG` | Six jurisdictions, including the Falklands and British Antarctic Territory |
| `BI` / `BG` | Iceland is EASA; Greenland is Danish and outside the EU |
| `LT` | Turkey, not EASA |
| `TFFF` / `NTAA` | Martinique is EASA, Tahiti is not. Both are France |
| `GCLP` | The Canaries are fully EASA, inside the African G block |

The plugin bundles an ICAO to ISO-country table generated from OurAirports
(public domain, about 25 000 rows, well under 100 KB), then maps the country
to a rule set. SERA applies in the 31 EASA states, the EU outermost regions,
and the United Kingdom with its crown dependencies, which retained SERA as
assimilated law.

An unknown country gives **UNKN**, never a guess. A wrong regulator is worse
than no regulator.

### UNKN is a real answer

| Cause | Why it matters |
|---|---|
| Ceiling cannot be measured | `BKN///` in fog. Reading `///` as zero would report the worst category from data that says nothing |
| No cloud group at all | An observer who sees a clear sky sends SKC or NSC. Silence means the group is missing |
| Report is stale | The NOAA feed has served a seventeen-day-old report for EEEI while still assigning it a category. Default limit is 180 minutes |
| Country unknown | See above |

**Out of scope: GAFOR.** The General Aviation Forecast route-sector scheme is
too specific for this plugin. It covers route sectors rather than an
aerodrome, it exists only in a few countries, and it needs a different data
source. Decided 2026-09-05.

**Out of scope: NATO colour states.** Real, and genuinely European, but
military only. They never appear on a civil METAR, and computing one would
mean picking a national okta rule that no civil authority applies to a civil
aerodrome. If a METAR already carries a colour state, pass it through as
observed data; never invent one.

Two things hold whatever the rule set:

- The badge always prints its band as **text**. Colour is reinforcement,
  never the only channel — see section 7.
- Visibility and ceiling are each coloured by their own band, so the reader
  sees which of the two is driving the result.

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

## 6a. Resolving a TAF into hours

A TAF is a baseline plus amendments. Three group types behave differently,
and conflating them gives a wrong forecast that looks right.

| Group | Effect on the baseline | Shown as |
|---|---|---|
| `FM` | Replaces it entirely, from that minute | The block colour changes |
| `BECMG` | Replaces only the elements it names, after the window ends | Block colour changes; the window is dimmed |
| `TEMPO` / `PROB` | **Never** replaces it | A separate lower bar on the block |

Two decisions worth keeping:

- **Inside a BECMG window the worse of the two is shown**, because either may
  be found there. The block is dimmed to say the conditions are in flux.
- **A temporary deterioration gets its own channel**, never the block colour.
  Painting a TEMPO as the forecast would overstate it; hiding it would
  understate it. A TEMPO no worse than the forecast is not drawn at all.

Verified against 38 live TAFs from six continents: no failures and no empty
timelines.

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

**Nearest aerodrome** is resolved from the bundled table, with no network
call for the search itself. Set `icao` to `auto` and the plugin writes the
code it found back into the config, so the lookup happens once and the answer
is visible and overridable.

The position comes from the least invasive source available:

| Order | Source | Leaves the machine |
|---|---|---|
| 1 | `lat` and `lon` settings | No |
| 2 | The Omarchy weather plugin's stored location | No |
| 3 | `ipapi.co`, from the IP address | Yes |

Only the third is a new service, and it runs only when `auto` is asked for
and nothing has been resolved yet.

An aerodrome that also issues a TAF is preferred, since half the panel is the
forecast; failing that, any METAR station within 400 km.

---

## 8a. The bundled aerodrome table

`Stations.js` is generated by `dev/build-stations.js` from two public-domain
sources: the NOAA station cache, which says which stations actually report a
METAR and gives the ISO country, and OurAirports, which gives readable names.

7680 METAR stations, 3591 of them with a TAF. About 370 KB, held as one
string and indexed lazily, so a plugin that never asks pays nothing.

It answers three questions with no network call:

1. **Which country an ICAO code is in**, which decides the rule set.
2. **What the aerodrome is called.** The weather API's names are poor outside
   the United States — it calls EETN "Tallin Arpt".
3. **Which aerodrome is nearest a position.**

The first is the reason it exists. The ICAO prefix cannot answer it, and
every one of these is a real case the table gets right:

| Code | Prefix suggests | Actually |
|---|---|---|
| `UKBB` | United Kingdom | Ukraine |
| `EGYP` | United Kingdom | Falkland Islands |
| `EKVG` | Denmark | Faroe Islands, outside the EU |
| `BIKF` / `BGSF` | Same block | Iceland is EASA; Greenland is not |
| `TFFF` / `NTAA` | Both France | Martinique is EASA; Tahiti is not |
| `GCLP` | West Africa | The Canaries, fully EASA |
| `LTBA` | Southern Europe | Turkey, not EASA |

Regenerate monthly. It needs a network connection and about 13 MB of
download.

## 8b. Wording and units

Two presentation settings. Neither changes a threshold or a band — only how
the same answer is printed.

**`labels`** picks the wording of the European bands: `vmc` (default) prints
VMC / SVFR / IMC, the terms the regulation uses; `vfr` prints VFR / SVFR /
IFR, what most pilots say. The FAA bands read the same under both.

**`units`** picks one of three presets. Only the decoded rows follow it; the
raw report is always quoted verbatim.

| Preset | Wind | Visibility | Pressure | Temperature | Cloud height |
|---|---|---|---|---|---|
| `icao` (default) | kt | km | hPa | °C | ft |
| `metric` | m/s | km | hPa | °C | ft |
| `us` | kt | sm | inHg | °C | ft |

Research settled the third one, which was first proposed with cloud height in
metres. ICAO Annex 5 Table 3-4 does make the metre primary for height, so the
proposal looked right — but **no METAR anywhere encodes cloud that way.** The
code form carries a `KT`/`MPS` indicator for wind and has no metric option at
all for the cloud group, and all 25 live stations checked — Russia, China,
Mongolia and Kazakhstan included — send hundreds of feet. Metres for cloud
base exist only in Russian domestic minima (ВНГО), a different document from
the METAR. Showing them would invent a number no pilot reads off a report.

So `metric` differs from `icao` in exactly one field, the wind. That is a
real difference: Amendment 17 (2010) made m/s the Annex 5 primary for wind
speed specifically, airspeed kept km/h, and the `MPS` suffix is live in
Russian, Chinese, Mongolian and Kazakh reports. It is not a former-Soviet
pattern — Azerbaijan, Georgia and Armenia all report knots.

Two naming notes, so the text never oversells:

- `icao` is the international **convention**, not strict SI. The knot and the
  foot are Annex 5's permitted alternatives, and Table 4-1 sets no
  termination date for either.
- `us` is a national **deviation** under Convention Article 38. Statute miles
  and inches of mercury appear nowhere in Annex 5's operative tables.

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
| 3 | `Category.js` and tests | **Done.** 18 tests. 28 of 28 agree with NOAA `fltCat` |
| 4 | Skeleton plugin, pill on the bar | **Done.** Verified live at EETN, LOWG and EDDV |
| 5 | Panel decoded rows and raw box | **Done.** 11 Format.js tests |
| 6 | `Taf.js` and tests | **Done.** 20 tests. 38 live TAFs, no failures |
| 7 | Timeline strip | **Done.** One block per hour, TEMPO on its own channel |
| 8 | ICAO field, nearest lookup, fallbacks | **Done.** All three live-verified |
| 9 | README and first push | **Done** |
| 10 | Wording and unit presets | **Done.** Live-verified in all three |

Phases 1, 2, 3 and 6 need no running shell.

### Testing

There is no plugin test harness in Omarchy. The pattern comes from the
third-party Omarchy plugin `b.omadoro`: plain `node` with
`node:assert/strict`, no framework, plus `omarchy plugin validate`, plus a
runtime smoke test that boots a throwaway Quickshell in a temporary `HOME`
and asserts over IPC.

That technique extends to theme testing, with one correction:
`Color.currentThemePath` is built from `HOME`, and **ignores
`XDG_STATE_HOME`**. Stage a test theme at
`$test_home/.local/state/omarchy/current/theme`.

The `qmllint` stage skips itself where the tool is not installed.

---

## 11. Open questions

1. **A second aerodrome.** The scope is deliberately one. Supporting a
   destination as well as a departure would need a second pill or a switcher,
   and one repository ships one plugin id.
2. **Aerodrome name quality.** The bundled table fixes the worst of it, but a
   handful of stations have no OurAirports match and keep the weather API's
   abbreviated name.
