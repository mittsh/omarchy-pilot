#!/usr/bin/env node
//
// Regenerates Stations.js, the bundled aerodrome table.
//
//   node dev/build-stations.js
//
// Run it when the table goes stale — monthly is plenty. It needs a network
// connection and about 13 MB of download; the output is a few hundred KB.
//
// Two public-domain sources, joined:
//
//   aviationweather.gov/data/cache/stations.cache.json.gz
//       Says which stations actually report a METAR, and gives the ISO
//       country. That is the authoritative list for this plugin, because a
//       station that issues no METAR is useless to it.
//
//   ourairports-data/airports.csv
//       Gives readable names. The AWC names are poor outside the United
//       States: it calls EETN "Tallin Arpt", misspelled and abbreviated,
//       where OurAirports has "Lennart Meri Tallinn Airport".
//
// Licences: US federal data is public domain; OurAirports states "All data is
// released to the Public Domain". Attribution is in the README.

const fs = require("node:fs")
const path = require("node:path")
const zlib = require("node:zlib")

const STATIONS_URL = "https://aviationweather.gov/data/cache/stations.cache.json.gz"
const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
const USER_AGENT = "omarchy-pilot/0.1 (https://github.com/mittsh/omarchy-pilot)"

const repo = path.join(__dirname, "..")
const output = path.join(repo, "Stations.js")

async function download(url, gunzip) {
  process.stderr.write(`  fetching ${url}\n`)
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  return gunzip ? zlib.gunzipSync(buffer).toString("utf8") : buffer.toString("utf8")
}

// A minimal RFC 4180 reader. The names contain commas and quotes, so
// splitting on "," would corrupt them.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else field += c
      continue
    }
    if (c === '"') { quoted = true; continue }
    if (c === ",") { row.push(field); field = ""; continue }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue }
    if (c === "\r") continue
    field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

// The live CSV's column order differs from the published data dictionary, so
// every field is read by header name.
function indexAirports(csv) {
  const rows = parseCsv(csv)
  const header = rows[0]
  const col = {}
  header.forEach((name, i) => { col[name] = i })

  for (const required of ["ident", "icao_code", "name", "iso_country"]) {
    if (col[required] === undefined) throw new Error(`airports.csv has no '${required}' column`)
  }

  const byIcao = new Map()
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.length < header.length) continue
    // icao_code is the real code. `ident` holds synthetic values such as
    // K00A for FAA identifiers, which are not ICAO codes.
    const icao = (row[col.icao_code] || "").trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9]{3}$/.test(icao)) continue
    byIcao.set(icao, {
      name: (row[col.name] || "").trim(),
      country: (row[col.iso_country] || "").trim().toUpperCase()
    })
  }
  return byIcao
}

// AWC abbreviates. Expanding is cosmetic, but a panel header reading
// "Tallin Arpt" looks broken.
function tidyName(name) {
  return String(name || "")
    .replace(/\bArpt\b/g, "Airport")
    .replace(/\bIntl\b/g, "International")
    .replace(/\bAFB\b/g, "Air Force Base")
    .replace(/\s+/g, " ")
    .trim()
}

async function main() {
  const [stationsRaw, airportsRaw] = await Promise.all([
    download(STATIONS_URL, true),
    download(AIRPORTS_URL, false)
  ])

  const stations = JSON.parse(stationsRaw)
  const airports = indexAirports(airportsRaw)
  process.stderr.write(`  ${stations.length} stations, ${airports.size} airports with an ICAO code\n`)

  const records = []
  let namedFromOurAirports = 0
  let countryFromOurAirports = 0

  for (const station of stations) {
    const icao = (station.icaoId || "").trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9]{3}$/.test(icao)) continue
    // Only stations that actually report a METAR. The file also holds buoys
    // and wave stations, whose siteType is empty.
    if (!Array.isArray(station.siteType) || !station.siteType.includes("METAR")) continue
    if (typeof station.lat !== "number" || typeof station.lon !== "number") continue

    const better = airports.get(icao)
    let name = tidyName(station.site)
    let country = (station.country || "").trim().toUpperCase()

    if (better && better.name) { name = better.name; namedFromOurAirports++ }
    if (!country && better && better.country) { country = better.country; countryFromOurAirports++ }
    if (!country) continue   // without a country the rule set cannot be chosen

    records.push({
      icao,
      country,
      name,
      lat: Math.round(station.lat * 1000) / 1000,
      lon: Math.round(station.lon * 1000) / 1000,
      taf: Array.isArray(station.siteType) && station.siteType.includes("TAF") ? 1 : 0
    })
  }

  records.sort((a, b) => (a.icao < b.icao ? -1 : a.icao > b.icao ? 1 : 0))

  // One record per line, pipe separated. Kept as a single string and indexed
  // lazily, so loading the plugin costs nothing until a lookup happens.
  const lines = records.map((r) =>
    [r.icao, r.country, r.lat, r.lon, r.taf, r.name.replace(/[|\n]/g, " ")].join("|"))

  const generated = new Date().toISOString().slice(0, 10)
  const body = fs.readFileSync(path.join(__dirname, "stations-template.js"), "utf8")
    .replace("@@GENERATED@@", generated)
    .replace("@@COUNT@@", String(records.length))
    .replace("@@DATA@@", JSON.stringify(lines.join("\n")))

  fs.writeFileSync(output, body)

  const bytes = fs.statSync(output).size
  process.stderr.write(
    `\n  wrote ${path.relative(repo, output)}\n` +
    `  ${records.length} METAR stations, ${records.filter((r) => r.taf).length} with a TAF\n` +
    `  ${namedFromOurAirports} names improved, ${countryFromOurAirports} countries filled\n` +
    `  ${(bytes / 1024).toFixed(0)} KB\n`)
}

main().catch((error) => {
  process.stderr.write(`build-stations: ${error.message}\n`)
  process.exit(1)
})
