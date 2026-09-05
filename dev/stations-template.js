// Bundled aerodrome table. GENERATED FILE — do not edit.
//
//   Regenerate with: node dev/build-stations.js
//   Generated:       @@GENERATED@@
//   Stations:        @@COUNT@@
//
// Every station here reports a METAR. Built from the NOAA Aviation Weather
// Center station cache, joined to OurAirports for readable names. Both are
// public domain.
//
// It exists so the plugin can answer three questions with no network call:
//
//   1. Which country an ICAO code is in, which decides the rule set. The
//      ICAO prefix cannot answer this: UK is Ukraine, EG spans six
//      jurisdictions, Martinique is EASA and Tahiti is not.
//   2. What the aerodrome is called. The weather API's names are poor
//      outside the United States.
//   3. Which aerodrome is nearest a position.
//
// The rows are one long string, indexed lazily, so a plugin that never asks
// pays nothing for it.

var RAW = @@DATA@@

// icao|country|lat|lon|taf|name
var index = null

function ensureIndex() {
  if (index) return index
  index = {}
  var lines = RAW.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 6) continue
    index[parts[0]] = {
      icao: parts[0],
      country: parts[1],
      lat: parseFloat(parts[2]),
      lon: parseFloat(parts[3]),
      taf: parts[4] === "1",
      name: parts[5]
    }
  }
  return index
}

function lookup(icao) {
  var code = String(icao || "").trim().toUpperCase()
  if (code.length !== 4) return null
  return ensureIndex()[code] || null
}

function count() {
  return Object.keys(ensureIndex()).length
}

// Great-circle distance in kilometres.
function distanceKm(lat1, lon1, lat2, lon2) {
  var toRad = Math.PI / 180
  var earthRadiusKm = 6371
  var dLat = (lat2 - lat1) * toRad
  var dLon = (lon2 - lon1) * toRad
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// The nearest METAR-reporting aerodrome to a position.
//
// options:
//   requireTaf   only consider aerodromes that also issue a TAF
//   maxKm        give up beyond this distance. Default 500.
//   limit        return this many, nearest first. Default 1.
function nearest(lat, lon, options) {
  var opts = options || {}
  if (typeof lat !== "number" || typeof lon !== "number") return []
  if (isNaN(lat) || isNaN(lon)) return []

  var maxKm = opts.maxKm === undefined ? 500 : opts.maxKm
  var limit = opts.limit === undefined ? 1 : opts.limit
  var all = ensureIndex()
  var found = []

  for (var code in all) {
    var station = all[code]
    if (opts.requireTaf && !station.taf) continue
    // A cheap bounding-box reject before the trigonometry. One degree of
    // latitude is about 111 km, so this cannot exclude a real candidate.
    if (Math.abs(station.lat - lat) * 111 > maxKm) continue
    var km = distanceKm(lat, lon, station.lat, station.lon)
    if (km > maxKm) continue
    found.push({ station: station, distanceKm: Math.round(km * 10) / 10 })
  }

  found.sort(function (a, b) { return a.distanceKm - b.distanceKm })
  return found.slice(0, limit)
}

if (typeof module !== "undefined") {
  module.exports = {
    lookup: lookup,
    nearest: nearest,
    distanceKm: distanceKm,
    count: count
  }
}
