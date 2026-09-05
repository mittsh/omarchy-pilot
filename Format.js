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

function wind(report) {
  var w = report && report.wind
  if (!w) return "—"
  if (w.calm) return "Calm"

  var speed = w.speedKt === null ? "—" : w.speedKt + " kt"
  if (w.gustKt !== null && w.gustKt !== undefined) speed += " gusting " + w.gustKt

  if (w.variable) return "Variable " + speed
  if (w.direction === null) return speed

  var out = pad(w.direction, 3) + "°"
  if (w.varyFrom !== null && w.varyFrom !== undefined) {
    out += " (" + pad(w.varyFrom, 3) + "-" + pad(w.varyTo, 3) + "°)"
  }
  return out + "  " + speed
}

// -------------------------------------------------------------- visibility

// Shown in the unit the station reported, because converting is what makes
// two tools disagree about the same weather. A European 9999 is "10 km+",
// not "6+ sm".
function visibility(report) {
  var v = report && report.visibility
  if (!v) return "—"
  if (v.cavok) return "CAVOK"

  if (v.unitReported === "SM") {
    var miles = v.metres / 1609.344
    var text = miles >= 1 ? String(Math.round(miles)) : fraction(miles)
    if (v.atLeast) return "over " + text + " sm"
    if (v.atMost) return "under " + text + " sm"
    return text + " sm"
  }

  if (v.atLeast || v.metres >= 9999) return "10 km+"
  if (v.metres >= 1000) return (v.metres / 1000).toFixed(v.metres % 1000 === 0 ? 0 : 1) + " km"
  return v.metres + " m"
}

// US reports use eighths and quarters. 0.5 reads better as 1/2 than 0.5.
function fraction(miles) {
  var eighths = Math.round(miles * 8)
  var names = { 1: "1/8", 2: "1/4", 3: "3/8", 4: "1/2", 5: "5/8", 6: "3/4", 7: "7/8" }
  return names[eighths] || miles.toFixed(2)
}

// ------------------------------------------------------------------ clouds

function clouds(report) {
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
    text += layer.baseFt === null ? " ???" : " " + group(layer.baseFt) + " ft"
    if (layer.type) text += " " + layer.type
    parts.push(text)
  }
  return parts.length ? parts.join(", ") : "—"
}

// "None" for no ceiling, which is metar-taf.com's word and better than a
// dash. An unmeasurable ceiling says so rather than pretending.
function ceiling(category) {
  if (!category) return "—"
  if (category.ceilingUnlimited) return "None"
  if (category.ceilingFt === null || category.ceilingFt === undefined) return "Unknown"
  return group(category.ceilingFt) + " ft"
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
function pressure(report) {
  var p = report && report.pressure
  if (!p || (p.hPa === null && p.inHg === null)) return "—"
  if (p.unitReported === "A") return p.hPa + " hPa (" + p.inHg.toFixed(2) + " inHg)"
  return p.hPa + " hPa"
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
function rows(report, category, bandSlots) {
  var slots = bandSlots || {}
  var out = [
    { label: "Wind", value: wind(report) },
    { label: "Visibility", value: visibility(report), slot: slots.visibility || null },
    { label: "Clouds", value: clouds(report) },
    { label: "Ceiling", value: ceiling(category), slot: slots.ceiling || null }
  ]

  var wx = weather(report)
  if (wx) out.push({ label: "Weather", value: wx })

  out.push({ label: "Temp/Dew", value: temperature(report) })
  out.push({ label: "Humidity", value: humidity(report) })
  out.push({ label: "QNH", value: pressure(report) })
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
    compassPoint: compassPoint,
    windArrow: windArrow,
    group: group
  }
}
