// Where the reports come from, and how each one answers.
//
// Three sources, tried in order. They exist as a chain because a status bar
// that silently shows nothing is worse than one that is a minute stale: the
// first is the best answer, the others are different hosts on different
// infrastructure, so an outage at one does not blank the panel.
//
// Every source is free, keyless and returns RAW text. Raw-first is what lets
// one decoder serve all three; the decoded JSON offered by the first source
// is lossy outside the United States and the other two have none.
//
// Pure functions: a source describes the requests it needs and how to turn
// the responses into a METAR and a TAF. The fetching itself is the caller's.

var USER_AGENT_NOTE =
  "All three sources require an identifying User-Agent. NOAA blocks " +
  "unidentified automated traffic and api.met.no returns 403 without one."

var SOURCES = [
  {
    id: "awc",
    name: "aviationweather.gov",
    attribution: null,               // US federal data, public domain
    // One request returns both products, which is why this is first.
    requests: function (icao) {
      return [{
        key: "both",
        url: "https://aviationweather.gov/api/data/metar?ids=" + icao +
             "&format=raw&taf=true"
      }]
    },
    combine: function (responses) { return splitCombined(responses.both) }
  },

  {
    id: "tgftp",
    name: "tgftp.nws.noaa.gov",
    attribution: null,
    // Static text files on a different host and a different serving stack
    // from the API, so this survives an API-side outage or URL change.
    requests: function (icao) {
      return [
        { key: "metar", url: "https://tgftp.nws.noaa.gov/data/observations/metar/stations/" + icao + ".TXT" },
        { key: "taf", url: "https://tgftp.nws.noaa.gov/data/forecasts/taf/stations/" + icao + ".TXT" }
      ]
    },
    combine: function (responses) {
      return {
        metar: stripDateHeader(responses.metar),
        taf: stripTafKeyword(stripDateHeader(responses.taf))
      }
    }
  },

  {
    id: "metno",
    name: "api.met.no",
    // CC BY 4.0 requires credit. It is in the README and in the panel's
    // about text; do not drop it.
    attribution: "Weather data from MET Norway (CC BY 4.0)",
    requests: function (icao) {
      return [
        { key: "metar", url: "https://api.met.no/weatherapi/tafmetar/1.0/metar.txt?icao=" + icao },
        { key: "taf", url: "https://api.met.no/weatherapi/tafmetar/1.0/taf.txt?icao=" + icao }
      ]
    },
    // This one returns 24 hours of reports rather than the latest, so it is
    // last: it costs far more bytes for the same answer.
    combine: function (responses) {
      return {
        metar: lastReport(responses.metar),
        taf: lastReport(responses.taf)
      }
    }
  }
]

// ------------------------------------------------------------------ shapes

// The API returns the METAR, then the TAF wrapped over several lines.
// Everything from the TAF keyword onward belongs to the forecast.
function splitCombined(text) {
  var lines = String(text || "").split("\n")
  var metar = []
  var taf = []
  var inTaf = false

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (/^\s*TAF\b/.test(line)) inTaf = true
    if (inTaf) taf.push(line.replace(/\s+$/, ""))
    else if (line.trim()) metar.push(line.trim())
  }
  return { metar: metar.join(" ").trim(), taf: taf.join("\n").trim() }
}

// The static files open with "2026/09/05 11:50" on its own line.
function stripDateHeader(text) {
  var lines = String(text || "").split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    if (i === 0 && /^\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\s*$/.test(lines[i])) continue
    out.push(lines[i].replace(/\s+$/, ""))
  }
  return out.join("\n").trim()
}

// The forecast file writes the keyword twice: "TAF TAF EETN ...".
function stripTafKeyword(text) {
  return String(text || "").replace(/^\s*TAF\s+TAF\b/, "TAF").trim()
}

// met.no returns every report it holds, oldest first, each ending in "=".
// The last one is the current report.
function lastReport(text) {
  var lines = String(text || "").split("\n")
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].replace(/=\s*$/, "").trim()
    if (line) return line
  }
  return ""
}

// ------------------------------------------------------------------- api

function list() { return SOURCES }

function byId(id) {
  for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i]
  return null
}

function count() { return SOURCES.length }

// A result is only usable if the METAR decoded to something. A source that
// answers with an empty body — which is what an unknown ICAO code gets from
// the first source, as HTTP 204 — must fall through to the next one rather
// than count as a successful fetch.
function isUsable(result) {
  return !!(result && result.metar && result.metar.length > 10)
}

if (typeof module !== "undefined") {
  module.exports = {
    list: list,
    byId: byId,
    count: count,
    isUsable: isUsable,
    splitCombined: splitCombined,
    stripDateHeader: stripDateHeader,
    stripTafKeyword: stripTafKeyword,
    lastReport: lastReport,
    USER_AGENT_NOTE: USER_AGENT_NOTE
  }
}
