// TAF decoder and forecast timeline.
//
// A TAF is a baseline forecast plus a list of amendments. The hard part is
// not the grammar, it is resolving those amendments into "what is forecast at
// 15:00", which is the only question a timeline can answer.
//
// Three group types behave differently, and conflating them gives a wrong
// forecast that looks right:
//
//   FM     An instantaneous change. Everything after it replaces the
//          baseline from that minute on.
//   BECMG  A gradual change across a window. After the window the new
//          conditions prevail; during it, either may be found. Only the
//          elements the group names change; the rest carry forward.
//   TEMPO  Fluctuations lasting under an hour at a time, and under half the
//          period. It NEVER replaces the baseline. PROBnn is the same, with
//          a stated probability.
//
// So the timeline carries two answers per hour: the prevailing conditions,
// and separately whether something temporarily worse is forecast. Painting a
// TEMPO as if it were the forecast would overstate it; hiding it would
// understate it.
//
// Pure functions. The METAR group decoders and the category rules are
// injected, so this file has no imports and stays testable under node.

var Metar = null
var Category = null

function useMetar(module) { Metar = module }
function useCategory(module) { Category = module }

// ---------------------------------------------------------------- time

// A TAF time is a day and an hour, with no month. Resolve against an anchor
// date, rolling into the next month when the day has gone backwards.
//
// Hour 24 is legal and means midnight ending that day.
function resolveDayHour(day, hour, anchor, minute) {
  if (day === null || hour === null) return null
  var base = anchor instanceof Date ? anchor : new Date(anchor)
  if (isNaN(base.getTime())) return null

  var year = base.getUTCFullYear()
  var month = base.getUTCMonth()
  if (day < base.getUTCDate() - 15) month += 1        // wrapped into next month
  else if (day > base.getUTCDate() + 15) month -= 1   // anchor already wrapped

  return new Date(Date.UTC(year, month, day, hour, minute || 0, 0, 0))
}

function toInt(text) {
  var n = parseInt(String(text), 10)
  return isNaN(n) ? null : n
}

// ------------------------------------------------------- condition merging

function emptyConditions() {
  return { wind: null, visibility: null, clouds: null, weather: [] }
}

// Read the weather elements out of one group's tokens. Only what is present
// is set, so a BECMG that names only a wind leaves everything else alone.
function readConditions(tokens) {
  var out = emptyConditions()
  var sawCloud = false

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i]

    // Max and min temperature groups carry no ceiling or visibility.
    if (/^T[XN]M?\d{2}\/\d{4}Z$/.test(token)) continue

    if (!out.wind) {
      var wind = Metar.parseWind(token)
      if (wind) { out.wind = wind; continue }
    }

    if (!out.visibility) {
      var visibility = Metar.parseVisibility(token, tokens[i + 1])
      if (visibility) {
        out.visibility = visibility
        if (visibility.consumedNext) i++
        continue
      }
    }

    var cloud = Metar.parseCloud(token)
    if (cloud) {
      if (!sawCloud) { out.clouds = []; sawCloud = true }
      out.clouds.push(cloud)
      continue
    }

    var weather = Metar.parseWeather(token)
    if (weather) { out.weather.push(weather); continue }
  }

  // CAVOK carries "no cloud below 5000 ft" with it, so a group that says
  // CAVOK and nothing else has still cleared the sky.
  if (out.visibility && out.visibility.cavok && !sawCloud) {
    out.clouds = [{ cover: "NSC", baseFt: null, type: null, oktas: 0, raw: "CAVOK" }]
  }
  return out
}

// Later wins, but only for the elements it names.
function merge(base, change) {
  var out = {
    wind: change.wind || base.wind,
    visibility: change.visibility || base.visibility,
    clouds: change.clouds || base.clouds,
    weather: change.weather.length ? change.weather : base.weather
  }
  return out
}

// ---------------------------------------------------------------- parsing

var GROUP_START = /^(FM\d{6}|TEMPO|BECMG|PROB\d{2}|INTER)$/

function parse(raw, options) {
  var opts = options || {}
  var text = String(raw || "").replace(/=/g, " ").replace(/\s+/g, " ").trim()
  if (!text) return null

  var result = {
    raw: String(raw || "").trim(),
    station: null,
    issued: null,
    validFrom: null,
    validTo: null,
    amended: false,
    corrected: false,
    cancelled: false,
    nil: false,
    groups: [],
    unparsed: []
  }

  var tokens = text.split(" ")
  var i = 0

  // The tgftp text files repeat the keyword, giving "TAF TAF EETN ...".
  while (tokens[i] === "TAF") i++
  while (tokens[i] === "AMD" || tokens[i] === "COR") {
    if (tokens[i] === "AMD") result.amended = true
    else result.corrected = true
    i++
  }

  if (tokens[i] && /^[A-Z][A-Z0-9]{3}$/.test(tokens[i])) { result.station = tokens[i]; i++ }

  if (tokens[i] && /^(\d{2})(\d{2})(\d{2})Z$/.test(tokens[i])) {
    var t = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tokens[i])
    result.issued = resolveDayHour(toInt(t[1]), toInt(t[2]), opts.now || new Date(), toInt(t[3]))
    i++
  }

  if (tokens[i] === "NIL") { result.nil = true; return result }
  if (tokens[i] === "CNL") { result.cancelled = true; return result }

  // Validity, as day/hour pairs: 0512/0612.
  if (tokens[i] && /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.test(tokens[i])) {
    var v = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(tokens[i])
    var anchor = result.issued || opts.now || new Date()
    result.validFrom = resolveDayHour(toInt(v[1]), toInt(v[2]), anchor)
    result.validTo = resolveDayHour(toInt(v[3]), toInt(v[4]), anchor)
    i++
  }

  if (tokens[i] === "CNL") { result.cancelled = true; return result }

  // Everything left splits into groups on the change keywords. The tokens
  // before the first keyword are the baseline.
  var current = { type: "BASE", tokens: [], probability: null, from: result.validFrom, to: result.validTo }

  function push() {
    if (current.tokens.length === 0 && current.type !== "BASE") return
    current.conditions = readConditions(current.tokens)
    current.raw = (current.type === "BASE" ? "" : current.label + " ") + current.tokens.join(" ")
    result.groups.push(current)
  }

  for (; i < tokens.length; i++) {
    var token = tokens[i]

    if (GROUP_START.test(token)) {
      // A bare PROBnn prefixes the group that follows: "PROB40 TEMPO 0521/0603".
      if (/^PROB\d{2}$/.test(token)) {
        var probability = toInt(token.slice(4))
        if (tokens[i + 1] === "TEMPO" || tokens[i + 1] === "INTER") {
          push()
          current = newGroup(tokens[i + 1], probability, token + " " + tokens[i + 1])
          i++
        } else {
          push()
          current = newGroup("PROB", probability, token)
        }
        readWindow(current, tokens, i, result)
        continue
      }

      push()
      if (/^FM\d{6}$/.test(token)) {
        var fm = /^FM(\d{2})(\d{2})(\d{2})$/.exec(token)
        current = newGroup("FM", null, token)
        current.from = resolveDayHour(toInt(fm[1]), toInt(fm[2]),
          result.validFrom || opts.now || new Date(), toInt(fm[3]))
        current.to = result.validTo
        continue
      }

      current = newGroup(token, null, token)
      readWindow(current, tokens, i, result)
      continue
    }

    // The window token belongs to the keyword, not to the conditions.
    if (current.pendingWindow === i) { current.pendingWindow = -1; continue }
    current.tokens.push(token)
  }
  push()

  return result
}

function newGroup(type, probability, label) {
  return {
    type: type === "INTER" ? "TEMPO" : type,
    label: label,
    probability: probability,
    tokens: [],
    from: null,
    to: null,
    pendingWindow: -1
  }
}

// A TEMPO, BECMG or PROB group is followed by its own day/hour window.
function readWindow(group, tokens, index, result) {
  var next = tokens[index + 1]
  var m = next && /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(next)
  if (!m) return
  var anchor = result.validFrom || result.issued || new Date()
  group.from = resolveDayHour(toInt(m[1]), toInt(m[2]), anchor)
  group.to = resolveDayHour(toInt(m[3]), toInt(m[4]), anchor)
  group.pendingWindow = index + 1
}

// --------------------------------------------------------------- timeline

// One entry per hour of the validity period.
//
//   prevailing   the forecast conditions and their band
//   temporary    a TEMPO or PROB band that is WORSE than the prevailing one,
//                or null. Never merged into prevailing.
//   changing     inside a BECMG window, where either may be found
//
// options: { ruleSet, country, hours, now }
function timeline(taf, options) {
  var opts = options || {}
  if (!taf || !taf.validFrom || !taf.validTo) return []

  var maxHours = opts.hours || 30
  var out = []

  var base = null
  for (var g = 0; g < taf.groups.length; g++) {
    if (taf.groups[g].type === "BASE") { base = taf.groups[g].conditions; break }
  }
  if (!base) return []

  var startMs = taf.validFrom.getTime()
  var endMs = taf.validTo.getTime()
  var hourMs = 3600000

  for (var ms = startMs; ms < endMs && out.length < maxHours; ms += hourMs) {
    var time = new Date(ms)
    var prevailing = base
    var changing = false

    // Replay the amendments in order. FM and BECMG both alter the baseline;
    // TEMPO and PROB never do.
    for (var i = 0; i < taf.groups.length; i++) {
      var group = taf.groups[i]
      if (group.type === "BASE") continue
      if (group.type === "TEMPO" || group.type === "PROB") continue
      if (!group.from) continue

      if (group.type === "FM") {
        if (ms >= group.from.getTime()) prevailing = merge(prevailing, group.conditions)
        continue
      }

      if (group.type === "BECMG") {
        // After the window the change is complete. Inside it, either the old
        // or the new may be found, so take the worse of the two and say so.
        if (group.to && ms >= group.to.getTime()) {
          prevailing = merge(prevailing, group.conditions)
        } else if (group.to && ms >= group.from.getTime()) {
          changing = true
          prevailing = worseOf(prevailing, merge(prevailing, group.conditions), opts)
        }
      }
    }

    var temporary = null
    for (var j = 0; j < taf.groups.length; j++) {
      var temp = taf.groups[j]
      if (temp.type !== "TEMPO" && temp.type !== "PROB") continue
      if (!temp.from || !temp.to) continue
      if (ms < temp.from.getTime() || ms >= temp.to.getTime()) continue

      var candidate = bandOf(merge(prevailing, temp.conditions), opts)
      var prevailingBand = bandOf(prevailing, opts)
      // Only worth showing when it is worse than what is already forecast.
      if (candidate && prevailingBand && candidate.index > prevailingBand.index) {
        if (!temporary || candidate.index > temporary.band.index) {
          temporary = { band: candidate, probability: temp.probability, type: temp.type }
        }
      }
    }

    out.push({
      time: time,
      conditions: prevailing,
      band: bandOf(prevailing, opts),
      temporary: temporary,
      changing: changing
    })
  }

  return out
}

// Categorise a condition set by building the smallest object categorize()
// needs. Its ceilingFrom() takes a supplied `ceiling` before anything else.
function bandOf(conditions, options) {
  if (!conditions) return null
  var opts = options || {}

  var ceiling = conditions.clouds
    ? Metar.ceilingInfo(conditions.clouds)
    : { ft: null, unlimited: false, known: false }

  var result = Category.categorize({
    visibility: conditions.visibility,
    ceiling: ceiling,
    clouds: conditions.clouds || []
  }, { ruleSet: opts.ruleSet, country: opts.country })

  if (!result) return null

  // The index orders the bands best to worst, which is what "is this worse"
  // needs. UNKN sorts last so it never masks a real deterioration.
  var rules = Category.RULE_SETS[result.ruleSet]
  var index = rules ? indexOfBand(rules, result.key) : 99
  result.index = result.key === "unkn" ? -1 : index
  return result
}

function indexOfBand(rules, key) {
  for (var i = 0; i < rules.bands.length; i++) if (rules.bands[i].key === key) return i
  return 99
}

function worseOf(a, b, options) {
  var bandA = bandOf(a, options)
  var bandB = bandOf(b, options)
  if (!bandA) return b
  if (!bandB) return a
  return bandB.index > bandA.index ? b : a
}

// The raw forecast, one change group per line, which is how it is read.
function rawLines(taf) {
  if (!taf || !taf.raw) return []
  return String(taf.raw)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+(FM\d{6}|TEMPO|BECMG|INTER|PROB\d{2})/g, "\n$1")
    .split("\n")
    .map(function (line) { return line.trim() })
    .filter(function (line) { return line.length > 0 })
}

if (typeof module !== "undefined") {
  module.exports = {
    parse: parse,
    timeline: timeline,
    rawLines: rawLines,
    readConditions: readConditions,
    resolveDayHour: resolveDayHour,
    merge: merge,
    useMetar: useMetar,
    useCategory: useCategory
  }
}
