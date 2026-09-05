// Display formatting.
//
// Pure functions turning a decoded METAR into the strings the panel prints.
// Kept out of the QML so the exact wording is testable and so a change to a
// label cannot break the layout.
//
// The house style, taken from metar-taf.com: the value is large and the label
// is small, and the unit is welded to the value. "4 kt", never
// "Wind speed: 4 (knots)". Where they have a good string we use theirs
// verbatim — "10 km+", "None", "310° (270-360°)".

// ------------------------------------------------------------- unit sets
//
// Three presets. The raw METAR is never converted — it is quoted verbatim,
// because a pilot reads raw. Only the decoded rows follow the preset.
//
// Temperature is Celsius in all three. Aviation has no Fahrenheit convention;
// US METARs report Celsius too and only convert for public display.

// The order they are offered in, best default first.
var UNIT_ORDER = ["icao", "metric", "us"]

var UNIT_SETS = {
  // The default, and what the overwhelming majority of states report. The
  // knot and the foot are Annex 5's permitted alternatives, and Table 4-1
  // sets no termination date for either — 45 years of "temporary" and
  // counting. This is the international convention, not strict SI.
  icao: {
    id: "icao", name: "ICAO",
    wind: "kt", visibility: "km", pressure: "hPa", temperature: "C", altitude: "ft"
  },
  // The SI primaries, and closer to the letter of Annex 5 than the set above.
  // Amendment 17 (2010) replaced km/h with m/s as the primary for WIND speed
  // specifically; airspeed and ground speed kept km/h.
  //
  // Cloud height stays in feet, deliberately. Annex 5 makes the metre primary
  // for height, but no METAR anywhere encodes cloud that way: the code form
  // has a KT/MPS indicator for wind and no metric option at all for the cloud
  // group. Every m/s-reporting state checked — Russia, China, Mongolia,
  // Kazakhstan — still sends hundreds of feet. Metres for cloud base exist
  // only in Russian domestic minima, a different document from the METAR.
  metric: {
    id: "metric", name: "Metric",
    wind: "mps", visibility: "km", pressure: "hPa", temperature: "C", altitude: "ft"
  },
  // A national deviation, filed under Convention Article 38, rather than an
  // ICAO alternative: statute miles and inches of mercury appear nowhere in
  // Annex 5's operative tables.
  us: {
    id: "us", name: "US",
    wind: "kt", visibility: "sm", pressure: "inHg", temperature: "C", altitude: "ft"
  }
}

var KT_PER_MPS = 1.94384
var METRES_PER_STATUTE_MILE = 1609.344
var METRES_PER_FOOT = 0.3048

function unitsFor(name) {
  return UNIT_SETS[String(name || "").toLowerCase()] || UNIT_SETS.icao
}

function unitNames() { return UNIT_ORDER.slice() }

var COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
               "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

// A rotated arrow needs no font support and reads at any size. The arrow
// points the way the wind is going, which is the opposite of the direction a
// METAR reports.
var ARROWS = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"]

function pad(value, width) {
  var s = String(value)
  while (s.length < width) s = "0" + s
  return s
}

// 1234 becomes "1,234". Cloud bases and ceilings read better grouped.
function group(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function compassPoint(degrees) {
  if (degrees === null || degrees === undefined) return ""
  return COMPASS[Math.round(((degrees % 360) / 22.5)) % 16]
}

function windArrow(degrees) {
  if (degrees === null || degrees === undefined) return ""
  return ARROWS[Math.round(((degrees % 360) / 45)) % 8]
}

// -------------------------------------------------------------------- wind

// Metar.js normalises every wind to knots, whatever the report said, so this
// is the only place the display unit is decided.
function windSpeed(knots, units) {
  if (knots === null || knots === undefined) return null
  if (unitsFor(units.id || units).wind === "mps") return Math.round(knots / KT_PER_MPS)
  return Math.round(knots)
}

function windUnitLabel(units) {
  return unitsFor(units.id || units).wind === "mps" ? "m/s" : "kt"
}

function wind(report, unitSet) {
  var units = unitsFor(unitSet && unitSet.id ? unitSet.id : unitSet)
  var w = report && report.wind
  if (!w) return "—"
  if (w.calm) return "Calm"

  var label = windUnitLabel(units)
  var value = windSpeed(w.speedKt, units)
  var speed = value === null ? "—" : value + " " + label
  var gust = windSpeed(w.gustKt, units)
  if (gust !== null) speed += " gusting " + gust

  if (w.variable) return "Variable " + speed
  if (w.direction === null) return speed

  var out = pad(w.direction, 3) + "°"
  if (w.varyFrom !== null && w.varyFrom !== undefined) {
    out += " (" + pad(w.varyFrom, 3) + "-" + pad(w.varyTo, 3) + "°)"
  }
  return out + "  " + speed
}

// -------------------------------------------------------------- visibility

// Converted to the chosen preset. The raw METAR above it is never touched,
// so the reported figure is always one line away if the conversion looks
// surprising.
function visibility(report, unitSet) {
  var units = unitsFor(unitSet && unitSet.id ? unitSet.id : unitSet)
  var v = report && report.visibility
  if (!v) return "—"
  if (v.cavok) return "CAVOK"

  var metres = v.metres
  if (metres === null || metres === undefined) return "—"

  if (units.visibility === "sm") {
    var miles = metres / METRES_PER_STATUTE_MILE
    // "9999" means 10 km or more, which is 6.2 sm or more. Both conventions
    // round that to their own familiar figure rather than showing 6.2.
    if (v.atLeast) return Math.floor(miles) + " sm+"
    if (v.atMost) return "under " + fraction(miles) + " sm"
    return (miles >= 1 ? String(Math.round(miles)) : fraction(miles)) + " sm"
  }

  if (v.atLeast) return Math.round(metres / 1000) + " km+"
  if (v.atMost) return "under " + metres + " m"
  if (metres >= 1000) return (metres / 1000).toFixed(metres % 1000 === 0 ? 0 : 1) + " km"
  return metres + " m"
}

// US reports use eighths and quarters. 0.5 reads better as 1/2 than 0.5.
function fraction(miles) {
  var eighths = Math.round(miles * 8)
  var names = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" }
  return names[eighths] || miles.toFixed(2)
}

// ------------------------------------------------------------------ clouds

// Cloud bases are reported in hundreds of feet. Metres are rounded to the
// nearest ten, which is how a metric report writes them.
function altitude(feet, units) {
  if (feet === null || feet === undefined) return null
  if (unitsFor(units.id || units).altitude === "m") {
    return group(Math.round(feet * METRES_PER_FOOT / 10) * 10) + " m"
  }
  return group(feet) + " ft"
}

function clouds(report, unitSet) {
  var units = unitsFor(unitSet && unitSet.id ? unitSet.id : unitSet)
  var layers = (report && report.clouds) || []
  if (layers.length === 0) return "—"

  var parts = []
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i]
    if (layer.cover === "NSC") { parts.push("No significant cloud"); continue }
    if (layer.cover === "NCD") { parts.push("No cloud detected"); continue }
    if (layer.cover === "SKC" || layer.cover === "CLR") { parts.push("Clear"); continue }
    if (!layer.cover) continue

    var text = layer.cover
    text += layer.baseFt === null ? " ???" : " " + altitude(layer.baseFt, units)
    if (layer.type) text += " " + layer.type
    parts.push(text)
  }
  return parts.length ? parts.join(", ") : "—"
}

// "None" for no ceiling, which is metar-taf.com's word and better than a
// dash. An unmeasurable ceiling says so rather than pretending.
function ceiling(category, unitSet) {
  if (!category) return "—"
  if (category.ceilingUnlimited) return "None"
  if (category.ceilingFt === null || category.ceilingFt === undefined) return "Unknown"
  return altitude(category.ceilingFt, unitsFor(unitSet && unitSet.id ? unitSet.id : unitSet))
}

// ------------------------------------------------------- the smaller fields

function temperature(report) {
  if (!report || report.temperatureC === null) return "—"
  var t = format1(report.temperatureC)
  if (report.dewpointC === null) return t + " °C"
  return t + " / " + format1(report.dewpointC) + " °C"
}

// A whole number stays whole. The US remark block gives tenths, and those
// are worth showing.
function format1(value) {
  return value === Math.round(value) ? String(value) : value.toFixed(1)
}

function humidity(report) {
  if (!report || report.humidity === null) return "—"
  return report.humidity + "%"
}

// Hectopascals, because that is what a European QNH is set in. An inHg
// report is converted and both are shown, so nothing is lost.
function pressure(report, unitSet) {
  var units = unitsFor(unitSet && unitSet.id ? unitSet.id : unitSet)
  var p = report && report.pressure
  if (!p || (p.hPa === null && p.inHg === null)) return "—"
  // Metar.js fills both, converting whichever the report did not give, so
  // either preset is exact to its own rounding.
  if (units.pressure === "inHg") return p.inHg === null ? "—" : p.inHg.toFixed(2) + " inHg"
  return p.hPa === null ? "—" : p.hPa + " hPa"
}

function weather(report) {
  var list = (report && report.weather) || []
  if (list.length === 0) return report && report.weatherNotReported ? "Not reported" : ""
  var parts = []
  for (var i = 0; i < list.length; i++) parts.push(list[i].text)
  return parts.join(", ")
}

// ------------------------------------------------------------------- time

function pad2(n) { return n < 10 ? "0" + n : String(n) }

// The observation time in the viewer's own zone, which is what a pilot
// checks against a watch.
function localTime(date) {
  if (!date) return "—"
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes())
}

function zuluTime(date) {
  if (!date) return "—"
  return pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes()) + "Z"
}

// Age is a first-class field. A METAR is only as good as its age, and a
// stale one looks exactly like a fresh one until you print this.
function age(minutes) {
  if (minutes === null || minutes === undefined) return "—"
  if (minutes < 0) return "0m"
  if (minutes < 60) return minutes + "m"
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + "h " + (minutes % 60) + "m"
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h"
}

// Amber once a routine hourly report should have been replaced, red once a
// second one has been missed.
function ageLevel(minutes) {
  if (minutes === null || minutes === undefined) return "unknown"
  if (minutes >= 90) return "bad"
  if (minutes >= 40) return "warn"
  return "ok"
}

// ------------------------------------------------------------- the row set

// The decoded block, in one call. Each row carries an optional band slot so
// the panel can colour visibility and ceiling by their own category, which
// shows which of the two is driving the badge.
function rows(report, category, bandSlots, unitSet) {
  var slots = bandSlots || {}
  var units = unitsFor(unitSet && unitSet.id ? unitSet.id : unitSet)
  var out = [
    { label: "Wind", value: wind(report, units) },
    { label: "Visibility", value: visibility(report, units), slot: slots.visibility || null },
    { label: "Clouds", value: clouds(report, units) },
    { label: "Ceiling", value: ceiling(category, units), slot: slots.ceiling || null }
  ]

  var wx = weather(report)
  if (wx) out.push({ label: "Weather", value: wx })

  out.push({ label: "Temp/Dew", value: temperature(report) })
  out.push({ label: "Humidity", value: humidity(report) })
  out.push({ label: "QNH", value: pressure(report, units) })
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    wind: wind,
    visibility: visibility,
    clouds: clouds,
    ceiling: ceiling,
    temperature: temperature,
    humidity: humidity,
    pressure: pressure,
    weather: weather,
    localTime: localTime,
    zuluTime: zuluTime,
    age: age,
    ageLevel: ageLevel,
    rows: rows,
    unitsFor: unitsFor,
    unitNames: unitNames,
    altitude: altitude,
    windSpeed: windSpeed,
    UNIT_SETS: UNIT_SETS,
    UNIT_ORDER: UNIT_ORDER,
    compassPoint: compassPoint,
    windArrow: windArrow,
    group: group
  }
}
