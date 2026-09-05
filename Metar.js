// METAR decoder.
//
// Pure functions only. No clock, no network, no QML types. The caller supplies
// the current time, so the same input always gives the same output and the
// whole file is testable under node. The trailing module.exports block is
// invisible to QML, where `module` is undefined.
//
// Written against ICAO Annex 3 and the FAA formats, because both appear in the
// same data feed. The regional differences that matter are marked REGIONAL.

// ---------------------------------------------------------------- constants

var CLOUD_COVER_OKTAS = {
  SKC: 0,   // clear, manual report
  NCD: 0,   // no cloud detected, automatic report
  NSC: 0,   // no significant cloud
  CLR: 0,   // clear below 12000 ft, automatic US report
  FEW: 2,   // 1-2 oktas
  SCT: 4,   // 3-4 oktas
  BKN: 6,   // 5-7 oktas
  OVC: 8,   // 8 oktas
  VV: 8     // vertical visibility, sky obscured
}

// A ceiling is the lowest layer of BKN or more. VV counts: the sky is hidden.
var CEILING_COVERS = ["BKN", "OVC", "VV"]

var WEATHER_INTENSITY = {
  "-": "Light",
  "+": "Heavy",
  "VC": "In the vicinity"
}

var WEATHER_DESCRIPTOR = {
  MI: "Shallow", BC: "Patches of", PR: "Partial", DR: "Low drifting",
  BL: "Blowing", SH: "Showers of", TS: "Thunderstorm", FZ: "Freezing"
}

var WEATHER_PHENOMENON = {
  DZ: "Drizzle", RA: "Rain", SN: "Snow", SG: "Snow grains", IC: "Ice crystals",
  PL: "Ice pellets", GR: "Hail", GS: "Small hail", UP: "Unknown precipitation",
  BR: "Mist", FG: "Fog", FU: "Smoke", VA: "Volcanic ash", DU: "Dust",
  SA: "Sand", HZ: "Haze", PY: "Spray",
  PO: "Dust whirls", SQ: "Squalls", FC: "Funnel cloud", SS: "Sandstorm",
  DS: "Duststorm", NSW: "No significant weather"
}

var CLOUD_TYPE = { CB: "cumulonimbus", TCU: "towering cumulus" }

// ------------------------------------------------------------------ helpers

function isMissing(token) {
  // A field the station could not measure is sent as solidi: /////, //, ///.
  return /^\/+$/.test(String(token || ""))
}

function toInt(text) {
  var n = parseInt(String(text), 10)
  return isNaN(n) ? null : n
}

// METAR signs a negative temperature with a leading M, not a minus.
function signedTemp(text) {
  if (!text || isMissing(text)) return null
  var negative = text.charAt(0) === "M"
  var n = toInt(negative ? text.slice(1) : text)
  if (n === null) return null
  return negative ? -n : n
}

function round(value, places) {
  if (value === null || value === undefined) return null
  var factor = Math.pow(10, places || 0)
  return Math.round(value * factor) / factor
}

// ------------------------------------------------------------- unit bridges
//
// One conversion table, used everywhere. Getting any of these wrong is silent:
// the panel still renders, it just lies.

var KT_PER_MPS = 1.94384
var METRES_PER_STATUTE_MILE = 1609.344
var HPA_PER_INHG = 33.8639

function mpsToKnots(mps) { return mps === null ? null : mps * KT_PER_MPS }
function metresToStatuteMiles(m) { return m === null ? null : m / METRES_PER_STATUTE_MILE }
function statuteMilesToMetres(sm) { return sm === null ? null : sm * METRES_PER_STATUTE_MILE }
function inHgToHpa(inHg) { return inHg === null ? null : inHg * HPA_PER_INHG }
function hpaToInHg(hPa) { return hPa === null ? null : hPa / HPA_PER_INHG }

function celsiusToFahrenheit(c) { return c === null ? null : c * 9 / 5 + 32 }

// Magnus formula. Good to about 0.4% over the range a METAR reports.
function relativeHumidity(tempC, dewC) {
  if (tempC === null || dewC === null) return null
  var a = 17.625, b = 243.04
  var num = Math.exp(a * dewC / (b + dewC))
  var den = Math.exp(a * tempC / (b + tempC))
  return Math.max(0, Math.min(100, 100 * num / den))
}

// ------------------------------------------------------------ report time
//
// A METAR carries a day and a time but no month. Resolve against the caller's
// clock by walking back at most two days, and never return a future time
// beyond a small tolerance for clock skew.

function resolveReportTime(day, hour, minute, now) {
  if (day === null || hour === null || minute === null) return null
  var reference = now instanceof Date ? now : new Date(now)
  if (isNaN(reference.getTime())) return null

  var skewToleranceMs = 60 * 60 * 1000

  for (var back = 0; back <= 2; back++) {
    var probe = new Date(Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth(),
      reference.getUTCDate() - back,
      hour, minute, 0, 0
    ))
    // Re-stamp the day-of-month the report actually claims. Stepping the date
    // back first means a report from the 31st still resolves in the previous
    // month when today is the 1st.
    var candidate = new Date(Date.UTC(
      probe.getUTCFullYear(), probe.getUTCMonth(), day, hour, minute, 0, 0
    ))
    if (candidate.getUTCDate() !== day) continue
    if (candidate.getTime() - reference.getTime() <= skewToleranceMs) return candidate
  }
  return null
}

// ---------------------------------------------------------- group decoders

// dddffKT | dddffGggKT | VRBffKT | dddffMPS | /////KT
// REGIONAL: MPS is used across the former Soviet region. Reading it as knots
// understates the wind by a factor of about two.
function parseWind(token) {
  var m = /^(\d{3}|VRB|\/{3})(\d{2,3}|\/{2})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(token)
  if (!m) return null

  var unit = m[4]
  var toKnots = function (value) {
    if (value === null) return null
    if (unit === "MPS") return round(mpsToKnots(value), 0)
    if (unit === "KMH") return round(value / 1.852, 0)
    return value
  }

  var speed = isMissing(m[2]) ? null : toInt(m[2])
  var gust = m[3] === undefined ? null : toInt(m[3])
  var variable = m[1] === "VRB"
  var direction = (variable || isMissing(m[1])) ? null : toInt(m[1])

  return {
    direction: direction,
    variable: variable,
    speedKt: toKnots(speed),
    gustKt: toKnots(gust),
    unitReported: unit,
    calm: speed === 0 && direction === 0,
    varyFrom: null,
    varyTo: null
  }
}

// dddVddd — the sector a variable wind swung through.
function parseWindVariation(token) {
  var m = /^(\d{3})V(\d{3})$/.exec(token)
  return m ? { from: toInt(m[1]), to: toInt(m[2]) } : null
}

// REGIONAL: Europe reports metres, the US statute miles. Both are normalised
// to metres here; the formatter decides which unit to show.
function parseVisibility(token, nextToken) {
  // CAVOK replaces visibility, cloud and weather in one word.
  if (token === "CAVOK") {
    return { metres: 10000, atLeast: true, cavok: true, unitReported: "M" }
  }

  // 9999 means 10 km or more. 0000 means less than 50 m.
  var metric = /^(\d{4})(NDV|[NSEW]{1,2})?$/.exec(token)
  if (metric) {
    var v = toInt(metric[1])
    return {
      metres: v,
      atLeast: v === 9999,
      cavok: false,
      unitReported: "M",
      direction: metric[2] || null
    }
  }

  // Statute miles: 10SM, 1/2SM, P6SM, M1/4SM, and the split form "1 1/2SM".
  var sm = /^([PM])?(\d+)(?:\/(\d+))?SM$/.exec(token)
  if (sm) {
    var whole = toInt(sm[2])
    var miles = sm[3] ? whole / toInt(sm[3]) : whole
    return {
      metres: round(statuteMilesToMetres(miles), 0),
      atLeast: sm[1] === "P",
      atMost: sm[1] === "M",
      cavok: false,
      unitReported: "SM"
    }
  }

  // "1 1/2SM" arrives as two tokens. Recognised only when the second completes it.
  if (/^\d$/.test(token) && nextToken && /^\d+\/\d+SM$/.test(nextToken)) {
    var frac = /^(\d+)\/(\d+)SM$/.exec(nextToken)
    var total = toInt(token) + toInt(frac[1]) / toInt(frac[2])
    return {
      metres: round(statuteMilesToMetres(total), 0),
      atLeast: false, cavok: false, unitReported: "SM", consumedNext: true
    }
  }

  return null
}

// R28R/090065 | R28/P2000 | R06/M0150V0500U
function parseRvr(token) {
  var m = /^R(\d{2}[LCR]?)\/([PM])?(\d{4})(?:V([PM])?(\d{4}))?(FT)?([UDN])?$/.exec(token)
  if (!m) return null
  return {
    runway: m[1],
    lowest: toInt(m[3]),
    highest: m[5] ? toInt(m[5]) : null,
    prefix: m[2] || null,
    unit: m[6] ? "FT" : "M",
    trend: m[7] || null,
    raw: token
  }
}

function parseWeather(token) {
  if (token === "NSW") return { raw: token, text: WEATHER_PHENOMENON.NSW }

  var m = /^(-|\+|VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ))?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS){1,3})?$/.exec(token)
  if (!m || (!m[2] && !m[3])) return null

  var parts = []
  if (m[1] && m[1] !== "VC") parts.push(WEATHER_INTENSITY[m[1]])
  if (m[2]) parts.push(WEATHER_DESCRIPTOR[m[2]])

  if (m[3]) {
    var phenomena = []
    for (var i = 0; i < m[3].length; i += 2) {
      var code = m[3].substr(i, 2)
      if (WEATHER_PHENOMENON[code]) phenomena.push(WEATHER_PHENOMENON[code])
    }
    parts.push(phenomena.join(" and "))
  }
  if (m[1] === "VC") parts.push("in the vicinity")

  var text = parts.filter(function (p) { return !!p }).join(" ")
  // Only the first word is capitalised, so "Light rain" not "Light Rain".
  text = text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
  return { raw: token, text: text }
}

// FEW030 | SCT025CB | BKN012TCU | OVC008 | VV002 | NSC | BKN/// | ///////
function parseCloud(token) {
  if (token === "NSC" || token === "NCD" || token === "SKC" || token === "CLR") {
    return { cover: token, baseFt: null, type: null, oktas: 0, raw: token }
  }

  var m = /^(FEW|SCT|BKN|OVC|VV|\/{3})(\d{3}|\/{3})(CB|TCU|\/{3})?$/.exec(token)
  if (!m) return null

  var cover = isMissing(m[1]) ? null : m[1]
  // A height of /// means the station could not measure the base. RJTT sends
  // BKN/// in fog. Treating that as 0 ft would fabricate a zero ceiling, so it
  // stays null and the category logic reports UNKN instead.
  var baseFt = isMissing(m[2]) ? null : toInt(m[2]) * 100

  return {
    cover: cover,
    baseFt: baseFt,
    type: m[3] && !isMissing(m[3]) ? m[3] : null,
    typeText: m[3] && CLOUD_TYPE[m[3]] ? CLOUD_TYPE[m[3]] : null,
    oktas: cover ? CLOUD_COVER_OKTAS[cover] : null,
    raw: token
  }
}

// REGIONAL: Q is QNH in whole hectopascals, A is inches of mercury times 100.
function parsePressure(token) {
  var q = /^Q(\d{4}|\/{4})$/.exec(token)
  if (q) {
    if (isMissing(q[1])) return { hPa: null, inHg: null, unitReported: "Q" }
    var hPa = toInt(q[1])
    return { hPa: hPa, inHg: round(hpaToInHg(hPa), 2), unitReported: "Q" }
  }

  var a = /^A(\d{4}|\/{4})$/.exec(token)
  if (a) {
    if (isMissing(a[1])) return { hPa: null, inHg: null, unitReported: "A" }
    var inHg = toInt(a[1]) / 100
    return { hPa: round(inHgToHpa(inHg), 0), inHg: inHg, unitReported: "A" }
  }
  return null
}

// 16/10 | M02/M05 | 16/// | /////
function parseTemperatures(token) {
  var m = /^(M?\d{2}|\/{2})\/(M?\d{2}|\/{2})$/.exec(token)
  if (!m) return null
  return { temperatureC: signedTemp(m[1]), dewpointC: signedTemp(m[2]) }
}

// The US remark block carries the same values to a tenth of a degree.
// T01170100 = temperature +11.7, dewpoint +10.0. Sign digit 1 means negative.
function parseRemarkTemperatures(remarks) {
  var m = /\bT([01])(\d{3})([01])(\d{3})\b/.exec(remarks || "")
  if (!m) return null
  return {
    temperatureC: (m[1] === "1" ? -1 : 1) * toInt(m[2]) / 10,
    dewpointC: (m[3] === "1" ? -1 : 1) * toInt(m[4]) / 10
  }
}

// SLP099 = sea level pressure 1009.9 hPa. SLP882 = 988.2. The leading 9 or 10
// is implied by which is nearer to 1000.
function parseRemarkSeaLevelPressure(remarks) {
  var m = /\bSLP(\d{3})\b/.exec(remarks || "")
  if (!m) return null
  var value = toInt(m[1]) / 10
  return value >= 50 ? 900 + value : 1000 + value
}

// -------------------------------------------------------------- the parser

function parse(raw, options) {
  var opts = options || {}
  var text = String(raw || "").trim().replace(/=$/, "").trim()
  if (!text) return null

  var result = {
    raw: text,
    station: null,
    time: null,
    auto: false,
    corrected: false,
    nil: false,
    wind: null,
    visibility: null,
    rvr: [],
    weather: [],
    clouds: [],
    ceilingFt: null,
    temperatureC: null,
    dewpointC: null,
    humidity: null,
    pressure: null,
    trend: null,
    remarks: null,
    unparsed: []
  }

  // Split the remarks off first. Everything after RMK is a different grammar,
  // and feeding it to the main loop produces false matches.
  var rmkAt = text.search(/\bRMK\b/)
  var body = text
  if (rmkAt !== -1) {
    body = text.slice(0, rmkAt).trim()
    result.remarks = text.slice(rmkAt + 3).trim()
  }

  // A trend group is a forecast, not an observation. Keep it, do not decode it
  // into the observed fields.
  var trendAt = body.search(/\b(NOSIG|TEMPO|BECMG)\b/)
  if (trendAt !== -1) {
    result.trend = body.slice(trendAt).trim()
    body = body.slice(0, trendAt).trim()
  }

  var tokens = body.split(/\s+/).filter(function (t) { return t.length > 0 })
  var i = 0

  // Optional report type.
  if (tokens[i] === "METAR" || tokens[i] === "SPECI") { result.reportType = tokens[i]; i++ }
  if (tokens[i] === "COR") { result.corrected = true; i++ }

  // Station identifier.
  if (tokens[i] && /^[A-Z][A-Z0-9]{3}$/.test(tokens[i])) { result.station = tokens[i]; i++ }

  // Day, hour, minute in UTC.
  if (tokens[i] && /^(\d{2})(\d{2})(\d{2})Z$/.test(tokens[i])) {
    var t = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[i])
    result.day = toInt(t[1])
    result.hour = toInt(t[2])
    result.minute = toInt(t[3])
    result.time = resolveReportTime(result.day, result.hour, result.minute, opts.now || new Date())
    i++
  }

  if (tokens[i] === "NIL") { result.nil = true; return result }
  if (tokens[i] === "AUTO") { result.auto = true; i++ }
  if (tokens[i] === "COR") { result.corrected = true; i++ }

  // Order in a METAR is fixed, but stations omit groups freely. Rather than
  // assume positions, try each decoder against each remaining token.
  var windSeen = false
  var visibilitySeen = false

  for (; i < tokens.length; i++) {
    var token = tokens[i]

    if (token === "$" || token === "RMK") continue

    // An automatic station with no present-weather sensor sends a bare //.
    // It means "not reported", which is not the same as "no weather".
    if (token === "//") { result.weatherNotReported = true; continue }

    if (!windSeen) {
      var wind = parseWind(token)
      if (wind) { result.wind = wind; windSeen = true; continue }
    }

    if (result.wind && !result.wind.varyFrom) {
      var variation = parseWindVariation(token)
      if (variation) {
        result.wind.varyFrom = variation.from
        result.wind.varyTo = variation.to
        continue
      }
    }

    if (!visibilitySeen) {
      var visibility = parseVisibility(token, tokens[i + 1])
      if (visibility) {
        result.visibility = visibility
        visibilitySeen = true
        if (visibility.consumedNext) i++
        if (visibility.cavok) result.cavok = true
        continue
      }
    }

    var rvr = parseRvr(token)
    if (rvr) { result.rvr.push(rvr); continue }

    var cloud = parseCloud(token)
    if (cloud) { result.clouds.push(cloud); continue }

    var temps = parseTemperatures(token)
    if (temps) {
      result.temperatureC = temps.temperatureC
      result.dewpointC = temps.dewpointC
      continue
    }

    var pressure = parsePressure(token)
    if (pressure) { result.pressure = pressure; continue }

    // Recent weather, wind shear and runway state are recognised so they do
    // not fall through to the weather decoder and become nonsense.
    if (/^RE/.test(token) && token.length <= 6) { result.recentWeather = token; continue }
    if (token === "WS" || /^WS\d{2}[LCR]?$/.test(token) || token === "ALL" || token === "RWY") {
      result.windShear = (result.windShear ? result.windShear + " " : "") + token
      continue
    }
    if (/^R\d{2}[LCR]?\/[\d/]{6}$/.test(token)) { result.runwayState = token; continue }

    var weather = parseWeather(token)
    if (weather) { result.weather.push(weather); continue }

    result.unparsed.push(token)
  }

  // A CAVOK report states no cloud below 5000 ft and no significant weather.
  if (result.cavok && result.clouds.length === 0) {
    result.clouds.push({ cover: "NSC", baseFt: null, type: null, oktas: 0, raw: "CAVOK" })
  }

  result.ceilingFt = ceilingOf(result.clouds)

  // Prefer the tenth-of-a-degree values from the US remark block.
  var precise = parseRemarkTemperatures(result.remarks)
  if (precise) {
    result.temperatureC = precise.temperatureC
    result.dewpointC = precise.dewpointC
  }
  var slp = parseRemarkSeaLevelPressure(result.remarks)
  if (slp !== null) result.seaLevelPressureHpa = slp

  result.humidity = round(relativeHumidity(result.temperatureC, result.dewpointC), 0)

  return result
}

// The lowest broken, overcast or vertical-visibility layer, in feet.
// Null means no ceiling was reported, which is not the same as no ceiling
// existing — see the BKN/// case in parseCloud.
function ceilingOf(clouds) {
  var lowest = null
  for (var i = 0; i < (clouds || []).length; i++) {
    var layer = clouds[i]
    if (!layer.cover) continue
    if (CEILING_COVERS.indexOf(layer.cover) === -1) continue
    if (layer.baseFt === null) continue
    if (lowest === null || layer.baseFt < lowest) lowest = layer.baseFt
  }
  return lowest
}

// Three states, not two. A flight category cannot be computed from
// ceilingOf() alone, because null conflates "the sky is clear" with "the
// station could not measure it", and those must give opposite answers.
//
//   { ft: 1700, unlimited: false, known: true }   a real ceiling
//   { ft: null, unlimited: true,  known: true }   nothing at or above broken
//   { ft: null, unlimited: false, known: false }  cannot be determined
function ceilingInfo(clouds) {
  var layers = clouds || []
  if (layers.length === 0) {
    // No cloud group at all. An observer who saw a clear sky sends SKC or
    // NSC, so silence means the group is missing, not that the sky is clear.
    return { ft: null, unlimited: false, known: false }
  }

  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i]
    // A ceiling-forming layer whose base could not be measured, such as
    // BKN/// in fog. The ceiling is real but its height is unknown.
    if (layer.cover && CEILING_COVERS.indexOf(layer.cover) !== -1 && layer.baseFt === null) {
      return { ft: null, unlimited: false, known: false }
    }
  }

  var lowest = ceilingOf(layers)
  if (lowest !== null) return { ft: lowest, unlimited: false, known: true }
  return { ft: null, unlimited: true, known: true }
}

// True when the report is old enough that it should not be trusted at face
// value. A routine METAR is issued hourly, so 90 minutes means one was missed.
function ageMinutes(report, now) {
  if (!report || !report.time) return null
  var reference = now instanceof Date ? now : new Date(now)
  return Math.floor((reference.getTime() - report.time.getTime()) / 60000)
}

if (typeof module !== "undefined") {
  module.exports = {
    parse: parse,
    parseWind: parseWind,
    parseWindVariation: parseWindVariation,
    parseVisibility: parseVisibility,
    parseRvr: parseRvr,
    parseWeather: parseWeather,
    parseCloud: parseCloud,
    parsePressure: parsePressure,
    parseTemperatures: parseTemperatures,
    parseRemarkTemperatures: parseRemarkTemperatures,
    parseRemarkSeaLevelPressure: parseRemarkSeaLevelPressure,
    resolveReportTime: resolveReportTime,
    ceilingOf: ceilingOf,
    ceilingInfo: ceilingInfo,
    ageMinutes: ageMinutes,
    relativeHumidity: relativeHumidity,
    mpsToKnots: mpsToKnots,
    metresToStatuteMiles: metresToStatuteMiles,
    statuteMilesToMetres: statuteMilesToMetres,
    inHgToHpa: inHgToHpa,
    hpaToInHg: hpaToInHg,
    celsiusToFahrenheit: celsiusToFahrenheit,
    CLOUD_COVER_OKTAS: CLOUD_COVER_OKTAS,
    CEILING_COVERS: CEILING_COVERS
  }
}
