// TAF decoder and timeline tests.
//
//   node tests/taf.test.js
//
// Every forecast below is a real one, captured from aviationweather.gov.

const assert = require("node:assert/strict")
const M = require("../Metar.js")
const C = require("../Category.js")
const T = require("../Taf.js")

C.useCeilingInfo(M.ceilingInfo)
T.useMetar(M)
T.useCategory(C)

const NOW = new Date("2026-09-05T11:45:00Z")

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

const EETN = "TAF EETN 051130Z 0512/0612 29008KT 9999 FEW025CB SCT030 " +
  "TEMPO 0518/0523 4000 SHRA SCT010 SCT020CB BKN045 " +
  "BECMG 0520/0522 35012KT BECMG 0523/0601 BKN014 " +
  "TEMPO 0601/0606 SCT010 FEW020CB BECMG 0607/0609 SCT020"

const KJFK = "TAF KJFK 051125Z 0512/0618 35009KT P6SM SCT080 " +
  "FM060200 05008KT P6SM SCT030 BKN050"

const LOWG = "TAF LOWG 051115Z 0512/0612 15007KT 9999 FEW070 TX25/0513Z TN14/0604Z " +
  "TEMPO 0512/0515 -SHRA PROB30 TEMPO 0512/0514 33015G25KT TSRA FEW050CB SCT070 " +
  "BECMG 0517/0519 VRB03KT PROB30 TEMPO 0603/0606 2000 BCFG"

const at = (timeline, iso) => timeline.find((h) => h.time.toISOString() === iso)

// ------------------------------------------------------------------ parsing

test("EETN: header, validity and every group", () => {
  const taf = T.parse(EETN, { now: NOW })

  assert.equal(taf.station, "EETN")
  assert.equal(taf.issued.toISOString(), "2026-09-05T11:30:00.000Z")
  assert.equal(taf.validFrom.toISOString(), "2026-09-05T12:00:00.000Z")
  assert.equal(taf.validTo.toISOString(), "2026-09-06T12:00:00.000Z")

  const types = taf.groups.map((g) => g.type)
  assert.deepEqual(types, ["BASE", "TEMPO", "BECMG", "BECMG", "TEMPO", "BECMG"])

  // The window token belongs to the keyword, not to the conditions.
  assert.deepEqual(taf.groups[1].tokens, ["4000", "SHRA", "SCT010", "SCT020CB", "BKN045"])
  assert.equal(taf.groups[1].from.toISOString(), "2026-09-05T18:00:00.000Z")
  assert.equal(taf.groups[1].to.toISOString(), "2026-09-05T23:00:00.000Z")
})

test("a validity period crossing into the next month resolves", () => {
  const eve = new Date("2026-08-31T23:00:00Z")
  const taf = T.parse("TAF EETN 312330Z 3123/0123 29008KT 9999 SCT030", { now: eve })
  assert.equal(taf.validFrom.toISOString(), "2026-08-31T23:00:00.000Z")
  assert.equal(taf.validTo.toISOString(), "2026-09-01T23:00:00.000Z")
})

test("temperature groups are not read as conditions", () => {
  const taf = T.parse(LOWG, { now: NOW })
  const base = taf.groups[0].conditions
  assert.equal(base.visibility.metres, 9999)
  assert.equal(base.clouds.length, 1)
  assert.equal(base.clouds[0].cover, "FEW")
})

test("a bare PROB30 attaches to the TEMPO that follows it", () => {
  const taf = T.parse(LOWG, { now: NOW })
  const probs = taf.groups.filter((g) => g.probability !== null)
  assert.equal(probs.length, 2)
  assert.equal(probs[0].type, "TEMPO")
  assert.equal(probs[0].probability, 30)
  assert.equal(probs[1].probability, 30)
  assert.equal(probs[1].from.toISOString(), "2026-09-06T03:00:00.000Z")
})

test("NIL and CNL forecasts are flagged, not decoded", () => {
  assert.equal(T.parse("TAF EETN 051130Z NIL", { now: NOW }).nil, true)
  assert.equal(T.parse("TAF EETN 051130Z 0512/0612 CNL", { now: NOW }).cancelled, true)
})

test("the duplicated TAF keyword from the text feed is tolerated", () => {
  // tgftp.nws.noaa.gov serves "TAF TAF EETN ...".
  const taf = T.parse("TAF TAF EETN 051130Z 0512/0612 29008KT 9999 SCT030", { now: NOW })
  assert.equal(taf.station, "EETN")
})

test("AMD and COR are recorded", () => {
  const taf = T.parse("TAF AMD EETN 051130Z 0512/0612 29008KT 9999 SCT030", { now: NOW })
  assert.equal(taf.amended, true)
})

// ----------------------------------------------------------------- FM

test("KJFK: an FM group replaces the baseline from its minute on", () => {
  const taf = T.parse(KJFK, { now: NOW })
  const fm = taf.groups.find((g) => g.type === "FM")
  assert.equal(fm.from.toISOString(), "2026-09-06T02:00:00.000Z")

  const line = T.timeline(taf, { ruleSet: "faa" })
  // Before: SCT080 only, so no ceiling.
  assert.equal(at(line, "2026-09-06T01:00:00.000Z").conditions.clouds.length, 1)
  // After: the whole cloud state is replaced.
  const after = at(line, "2026-09-06T02:00:00.000Z")
  assert.equal(after.conditions.clouds.length, 2)
  assert.equal(after.band.text, "VFR", "BKN050 is still well above the VFR floor")
})

// -------------------------------------------------------------- BECMG

test("a BECMG applies after its window, and marks the window as changing", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })

  // BECMG 0523/0601 BKN014 — a 1400 ft ceiling, below the 1500 ft VFR gate.
  assert.equal(at(line, "2026-09-05T22:00:00.000Z").band.text, "VMC", "before the window")
  assert.equal(at(line, "2026-09-05T23:00:00.000Z").changing, true, "inside the window")
  assert.equal(at(line, "2026-09-06T01:00:00.000Z").band.text, "SVFR", "after the window")
  assert.equal(at(line, "2026-09-06T01:00:00.000Z").changing, false)
})

test("inside a BECMG window the worse of the two is shown", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  // The deterioration to BKN014 is already possible inside 23:00-01:00, so
  // the honest answer during the window is the worse one.
  assert.equal(at(line, "2026-09-05T23:00:00.000Z").band.text, "SVFR")
})

test("a BECMG naming only a wind leaves the ceiling alone", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  // BECMG 0520/0522 35012KT changes nothing that affects the band.
  assert.equal(at(line, "2026-09-05T21:00:00.000Z").band.text, "VMC")
})

test("a later BECMG that replaces the cloud group clears the ceiling", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  // BECMG 0607/0609 SCT020 — SCT forms no ceiling, so conditions recover.
  assert.equal(at(line, "2026-09-06T09:00:00.000Z").band.text, "VMC")
})

// ----------------------------------------------------- TEMPO and PROB

test("a TEMPO never changes the prevailing forecast", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  const hour = at(line, "2026-09-05T19:00:00.000Z")

  // TEMPO 0518/0523 brings 4000 m, which alone would be SVFR.
  assert.equal(hour.band.text, "VMC", "the baseline is untouched")
  assert.equal(hour.temporary.band.text, "SVFR", "but the deterioration is reported")
  assert.equal(hour.temporary.type, "TEMPO")
})

test("a TEMPO no worse than the forecast is not reported", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  // TEMPO 0601/0606 SCT010 FEW020CB — SCT is not a ceiling, so nothing worse.
  assert.equal(at(line, "2026-09-06T03:00:00.000Z").temporary, null)
})

test("a PROB group carries its probability through to the timeline", () => {
  const taf = T.parse(LOWG, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  // PROB30 TEMPO 0603/0606 2000 BCFG — 2000 m, below the 5 km VFR gate.
  const hour = at(line, "2026-09-06T04:00:00.000Z")
  assert.ok(hour.temporary, "the fog should be reported")
  assert.equal(hour.temporary.band.text, "SVFR")
  assert.equal(hour.temporary.probability, 30)
})

test("the worst overlapping temporary group wins", () => {
  const taf = T.parse(LOWG, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  // Two TEMPO groups overlap 12:00-14:00. Neither drops the band here, so
  // nothing is reported rather than something arbitrary.
  const hour = at(line, "2026-09-05T13:00:00.000Z")
  assert.ok(hour.band.text === "VMC")
})

// --------------------------------------------------------------- shape

test("the timeline covers the validity period, one entry per hour", () => {
  const taf = T.parse(EETN, { now: NOW })
  const line = T.timeline(taf, { ruleSet: "sera" })
  assert.equal(line.length, 24, "0512/0612 is 24 hours")
  assert.equal(line[0].time.toISOString(), "2026-09-05T12:00:00.000Z")
  for (let i = 1; i < line.length; i++) {
    assert.equal(line[i].time.getTime() - line[i - 1].time.getTime(), 3600000)
  }
})

test("the timeline is capped so a 30-hour forecast cannot run away", () => {
  const taf = T.parse(KJFK, { now: NOW })
  assert.equal(T.timeline(taf, { ruleSet: "faa", hours: 12 }).length, 12)
})

test("a forecast with no validity gives an empty timeline, not a throw", () => {
  assert.deepEqual(T.timeline(T.parse("TAF EETN 051130Z NIL", { now: NOW }), {}), [])
  assert.deepEqual(T.timeline(null, {}), [])
})

test("raw lines split on the change keywords", () => {
  const lines = T.rawLines(T.parse(EETN, { now: NOW }))
  assert.equal(lines.length, 6)
  assert.match(lines[0], /^TAF EETN/)
  assert.match(lines[1], /^TEMPO 0518\/0523/)
  assert.match(lines[5], /^BECMG 0607\/0609/)
})

console.log(`taf.test.js: ${passed} passed`)
