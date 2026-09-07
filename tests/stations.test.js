// Bundled aerodrome table tests.
//
//   node tests/stations.test.js
//
// The table exists so the plugin never has to guess a regulator from an ICAO
// prefix. Most of these cases are the ones where a prefix rule gets it wrong.

const assert = require("node:assert/strict")
const S = require("../Stations.js")
const C = require("../Category.js")

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

test("the table holds a useful number of METAR stations", () => {
  const n = S.count()
  assert.ok(n > 6000, `expected over 6000 stations, got ${n}`)
  assert.ok(n < 12000, `expected under 12000 stations, got ${n}`)
})

test("a lookup gives country, name and position", () => {
  const eetn = S.lookup("EETN")
  assert.equal(eetn.country, "EE")
  assert.equal(eetn.name, "Lennart Meri Tallinn Airport")
  assert.equal(eetn.taf, true)
  assert.ok(Math.abs(eetn.lat - 59.41) < 0.1)
  assert.ok(Math.abs(eetn.lon - 24.83) < 0.1)
})

test("the name is the readable one, not the weather API's", () => {
  // The API calls these "Tallin Arpt" and "Chicago/O'Hare Arpt".
  assert.equal(S.lookup("EETN").name, "Lennart Meri Tallinn Airport")
  assert.match(S.lookup("KORD").name, /O'Hare/)
  assert.ok(!S.lookup("EETN").name.includes("Arpt"))
})

test("lookup is forgiving about case and spacing, strict about length", () => {
  assert.equal(S.lookup("eetn").icao, "EETN")
  assert.equal(S.lookup("  EETN  ").icao, "EETN")
  assert.equal(S.lookup("EET"), null)
  assert.equal(S.lookup(""), null)
  assert.equal(S.lookup(null), null)
  assert.equal(S.lookup("ZZZZ"), null)
})

// ------------------------------------------- the cases a prefix rule fails

test("every awkward territory resolves to the right country", () => {
  const cases = {
    UKBB: "UA",   // Ukraine, despite the UK prefix
    EGLL: "GB",
    EGYP: "FK",   // Mount Pleasant, Falklands, under the EG prefix
    LXGB: "GI",   // Gibraltar, a one-aerodrome L prefix
    EKVG: "FO",   // Faroes, under Denmark's EK prefix
    BIKF: "IS",   // Iceland, EASA
    BGSF: "GL",   // Greenland, Danish but outside the EU
    TFFF: "MQ",   // Martinique, an EU outermost region
    NTAA: "PF",   // Tahiti, an overseas territory
    GCLP: "ES",   // Canaries, in the African G block
    ETAR: "DE",   // Ramstein, a US air base on German soil
    LTBA: "TR",   // Turkey, in the L block
    PANC: "US",
    TJSJ: "PR"    // Puerto Rico
  }
  for (const [icao, country] of Object.entries(cases)) {
    const station = S.lookup(icao)
    assert.ok(station, `${icao} is missing from the table`)
    assert.equal(station.country, country, `${icao} should be ${country}`)
  }
})

test("the country picks the rule set the regulator actually applies", () => {
  const ruleFor = (icao) => C.ruleSetForCountry(S.lookup(icao).country).id

  assert.equal(ruleFor("EETN"), "sera")
  assert.equal(ruleFor("EGLL"), "sera", "the UK retained SERA")
  assert.equal(ruleFor("BIKF"), "sera", "Iceland is EASA")
  assert.equal(ruleFor("TFFF"), "sera", "Martinique is an outermost region")
  assert.equal(ruleFor("GCLP"), "sera", "the Canaries are Spain")

  assert.equal(ruleFor("UKBB"), "faa", "Ukraine is not EASA")
  assert.equal(ruleFor("NTAA"), "faa", "French Polynesia is not EASA")
  assert.equal(ruleFor("BGSF"), "faa", "Greenland is outside the EU")
  assert.equal(ruleFor("LTBA"), "faa", "Turkey is not EASA")
  assert.equal(ruleFor("KJFK"), "faa")

  // The same country, two rule sets, decided by territory.
  assert.notEqual(ruleFor("TFFF"), ruleFor("NTAA"))
  assert.equal(S.lookup("LFPG").country, "FR")
})

// ---------------------------------------------------------------- nearest

// Published landmark coordinates, so the fixtures cite a place rather than
// anybody's location.
const TALLINN_TOWN_HALL = { lat: 59.4372, lon: 24.7453 }
const SUVA_FIJI = { lat: -18.1416, lon: 178.4419 }

test("nearest finds the aerodrome you are standing next to", () => {
  const found = S.nearest(TALLINN_TOWN_HALL.lat, TALLINN_TOWN_HALL.lon, { limit: 1 })
  assert.equal(found.length, 1)
  assert.equal(found[0].station.icao, "EETN")
  assert.ok(found[0].distanceKm < 15, `expected under 15 km, got ${found[0].distanceKm}`)
})

test("nearest returns results in ascending distance", () => {
  const found = S.nearest(TALLINN_TOWN_HALL.lat, TALLINN_TOWN_HALL.lon, { limit: 5 })
  assert.equal(found.length, 5)
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i].distanceKm >= found[i - 1].distanceKm)
  }
})

test("requireTaf skips an aerodrome that issues no forecast", () => {
  const all = S.nearest(TALLINN_TOWN_HALL.lat, TALLINN_TOWN_HALL.lon, { limit: 20 })
  const tafOnly = S.nearest(TALLINN_TOWN_HALL.lat, TALLINN_TOWN_HALL.lon,
    { limit: 20, requireTaf: true })
  assert.ok(tafOnly.length <= all.length)
  for (const entry of tafOnly) assert.equal(entry.station.taf, true)
})

test("maxKm gives up rather than returning something absurd", () => {
  // The middle of the Pacific.
  assert.deepEqual(S.nearest(-40, -140, { maxKm: 500 }), [])
  assert.ok(S.nearest(-40, -140, { maxKm: 20000, limit: 1 }).length === 1)
})

test("nearest refuses a position it cannot use", () => {
  assert.deepEqual(S.nearest(null, null), [])
  assert.deepEqual(S.nearest(NaN, 24.7), [])
  assert.deepEqual(S.nearest("59", "24"), [])
})

test("distance matches a known great-circle figure", () => {
  // London Heathrow to Paris Charles de Gaulle is about 348 km.
  const lhr = S.lookup("EGLL")
  const cdg = S.lookup("LFPG")
  const km = S.distanceKm(lhr.lat, lhr.lon, cdg.lat, cdg.lon)
  assert.ok(Math.abs(km - 348) < 15, `expected about 348 km, got ${km.toFixed(1)}`)
  assert.equal(S.distanceKm(59.4, 24.8, 59.4, 24.8), 0)
})

test("a position on the far side of the antimeridian still works", () => {
  // Suva, Fiji. A naive longitude subtraction would look thousands of km out.
  const found = S.nearest(SUVA_FIJI.lat, SUVA_FIJI.lon, { limit: 1, maxKm: 300 })
  assert.equal(found.length, 1)
  assert.ok(found[0].distanceKm < 300)
})

console.log(`stations.test.js: ${passed} passed`)
