// Flight-category tests.
//
//   node tests/category.test.js

const assert = require("node:assert/strict")
const M = require("../Metar.js")
const C = require("../Category.js")

C.useCeilingInfo(M.ceilingInfo)

const NOW = new Date("2026-09-05T10:05:00Z")

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

// Categorize a raw METAR in one step.
function at(raw, country, extra) {
  const report = M.parse(raw, { now: NOW })
  return C.categorize(report, Object.assign({ country, now: NOW }, extra || {}))
}

// ------------------------------------------------------- choosing a rule set

test("the ISO country chooses the rule set, not the ICAO prefix", () => {
  assert.equal(C.ruleSetForCountry("EE").id, "sera", "Estonia")
  assert.equal(C.ruleSetForCountry("US").id, "faa")
  assert.equal(C.ruleSetForCountry("GB").id, "sera", "the UK retained SERA")
  assert.equal(C.ruleSetForCountry("CH").id, "sera", "Switzerland is EASA, not EU")
  assert.equal(C.ruleSetForCountry("IS").id, "sera", "Iceland is EASA")
  assert.equal(C.ruleSetForCountry(""), null, "an unknown country picks nothing")
})

test("the awkward territories resolve correctly", () => {
  // Each of these is a case where the ICAO prefix gives the wrong answer.
  assert.equal(C.ruleSetForCountry("UA").id, "faa", "Ukraine has the UK prefix but is not EASA")
  assert.equal(C.ruleSetForCountry("GL").id, "faa", "Greenland is Danish but outside the EU")
  assert.equal(C.ruleSetForCountry("TR").id, "faa", "Turkey sits in the L block")
  assert.equal(C.ruleSetForCountry("MQ").id, "sera", "Martinique is an outermost region")
  assert.equal(C.ruleSetForCountry("PF").id, "faa", "French Polynesia is an overseas territory")
  assert.equal(C.ruleSetForCountry("ES").id, "sera", "the Canaries are Spain")
  assert.equal(C.ruleSetForCountry("FO").id, "faa", "the Faroes are outside the EU")
  assert.equal(C.ruleSetForCountry("GI").id, "sera", "Gibraltar follows the UK")
})

// ------------------------------------------------------------- the SERA bands

test("EETN: a real report well inside VMC", () => {
  const r = at("METAR EETN 050950Z 31004KT 270V360 9999 FEW030CB 16/10 Q0995 NOSIG", "EE")
  assert.equal(r.ruleSet, "sera")
  assert.equal(r.text, "VMC")
  assert.equal(r.slot, "vfr")
  assert.equal(r.ceilingUnlimited, true, "FEW forms no ceiling")
  assert.equal(r.visibilityM, 9999)
})

test("SERA.5005(b): the VFR gate is 1500 ft and 5 km", () => {
  // Exactly at both floors is still VMC. The rule says "less than".
  assert.equal(at("EETN 050950Z 09004KT 5000 BKN015 10/08 Q1013", "EE").text, "VMC")
  // One step below the ceiling floor.
  const lowCeiling = at("EETN 050950Z 09004KT 9999 BKN014 10/08 Q1013", "EE")
  assert.equal(lowCeiling.text, "SVFR")
  assert.equal(lowCeiling.driver, "ceiling")
  // One step below the visibility floor.
  const lowVis = at("EETN 050950Z 09004KT 4000 BKN030 10/08 Q1013", "EE")
  assert.equal(lowVis.text, "SVFR")
  assert.equal(lowVis.driver, "visibility")
})

test("SERA.5010(c): the Special VFR floor is 600 ft and 1500 m", () => {
  assert.equal(at("EETN 050950Z 09004KT 1500 BKN006 10/08 Q1013", "EE").text, "SVFR")
  assert.equal(at("EETN 050950Z 09004KT 1400 BKN006 10/08 Q1013", "EE").text, "IMC")
  assert.equal(at("EETN 050950Z 09004KT 1500 BKN005 10/08 Q1013", "EE").text, "IMC")
})

test("the worse of ceiling and visibility wins", () => {
  // Good visibility, bad ceiling.
  const r = at("EETN 050950Z 09004KT 9999 OVC004 10/08 Q1013", "EE")
  assert.equal(r.text, "IMC")
  assert.equal(r.driver, "ceiling")
  // Bad visibility, good ceiling.
  const v = at("EETN 050950Z 09004KT 0800 FG SCT030 10/08 Q1013", "EE")
  assert.equal(v.text, "IMC")
  assert.equal(v.driver, "visibility")
})

test("both equally bad reports neither as the driver", () => {
  const r = at("EETN 050950Z 09004KT 4000 BKN010 10/08 Q1013", "EE")
  assert.equal(r.text, "SVFR")
  assert.equal(r.driver, "both")
})

test("CAVOK is the best band", () => {
  // Timed at 09:50Z so the staleness guard is not what is under test here.
  const r = at("EETN 050950Z VRB02KT CAVOK 11/11 Q0994 NOSIG", "EE")
  assert.equal(r.text, "VMC")
  assert.equal(r.ceilingUnlimited, true)
})

// -------------------------------------------------------------- the FAA bands

test("KJFK: the FAA bands apply in the United States", () => {
  const r = at("METAR KJFK 050951Z 02005KT 10SM BKN100 22/16 A2982 RMK AO2 SLP099 T02220156 $", "US")
  assert.equal(r.ruleSet, "faa")
  assert.equal(r.text, "VFR")
})

test("FAA AIM 7-1-7 boundaries are inclusive where the text says so", () => {
  // VFR alone is "greater than", so exactly 3000 ft is MVFR.
  assert.equal(at("KJFK 050951Z 02005KT 10SM BKN030 22/16 A2982", "US").text, "MVFR")
  assert.equal(at("KJFK 050951Z 02005KT 10SM BKN031 22/16 A2982", "US").text, "VFR")
  // Exactly 5 sm is MVFR, "3 to 5 miles inclusive".
  assert.equal(at("KJFK 050951Z 02005KT 5SM BKN100 22/16 A2982", "US").text, "MVFR")
  assert.equal(at("KJFK 050951Z 02005KT 6SM BKN100 22/16 A2982", "US").text, "VFR")
  // 1000 ft is the bottom of MVFR; below it is IFR.
  assert.equal(at("KJFK 050951Z 02005KT 10SM BKN010 22/16 A2982", "US").text, "MVFR")
  assert.equal(at("KJFK 050951Z 02005KT 10SM BKN009 22/16 A2982", "US").text, "IFR")
  // 500 ft is the bottom of IFR; below it is LIFR.
  assert.equal(at("KJFK 050951Z 02005KT 10SM BKN005 22/16 A2982", "US").text, "IFR")
  assert.equal(at("KJFK 050951Z 02005KT 10SM BKN004 22/16 A2982", "US").text, "LIFR")
  // Under 1 statute mile is LIFR.
  assert.equal(at("KJFK 050951Z 02005KT 1SM BKN100 22/16 A2982", "US").text, "IFR")
  assert.equal(at("KJFK 050951Z 02005KT 1/2SM BKN100 22/16 A2982", "US").text, "LIFR")
})

test("the same weather gives different labels under the two rule sets", () => {
  // 9000 m is 5.59 sm. The FAA calls that VFR; SERA calls it VMC too, but
  // for a different reason and with a different middle band beneath.
  const raw = "XXXX 050950Z 09004KT 4000 BKN020 10/08 Q1013"
  const sera = C.categorize(M.parse(raw, { now: NOW }), { country: "EE", now: NOW })
  const faa = C.categorize(M.parse(raw, { now: NOW }), { country: "US", now: NOW })
  assert.equal(sera.text, "SVFR", "below 5 km, so Special VFR only")
  assert.equal(faa.text, "IFR", "4000 m is 2.49 sm, which is IFR on visibility")
  assert.notEqual(sera.ruleSet, faa.ruleSet)
})

// ------------------------------------------------------------------ UNKN

test("a ceiling that cannot be measured is UNKN, not a false IMC", () => {
  // RJTT sends BKN/// in fog. Reading /// as a zero base would report the
  // worst possible category from data that says nothing.
  const r = at("RJTT 050950Z 09004KT 9999 BKN/// 10/08 Q1013", "JP")
  assert.equal(r.text, "UNKN")
  assert.equal(r.reason, "ceiling cannot be determined")
})

test("a missing cloud group is UNKN, because silence is not a clear sky", () => {
  const r = at("EETN 050950Z 09004KT 9999 10/08 Q1013", "EE")
  assert.equal(r.text, "UNKN")
})

test("a stale report is UNKN however good it looks", () => {
  // The NOAA feed has served a seventeen-day-old report for EEEI while still
  // assigning it a category.
  const old = new Date("2026-09-05T16:05:00Z")
  const r = C.categorize(
    M.parse("EETN 050950Z 09004KT 9999 SCT030 10/08 Q1013", { now: NOW }),
    { country: "EE", now: old, maxAgeMinutes: 180 }
  )
  assert.equal(r.text, "UNKN")
  assert.match(r.reason, /minutes old/)
})

test("an unknown country gives UNKN rather than a guess", () => {
  const r = at("XXXX 050950Z 09004KT 9999 SCT030 10/08 Q1013", "")
  assert.equal(r.text, "UNKN")
  assert.match(r.reason, /country unknown/)
})

test("a NIL report is UNKN", () => {
  assert.equal(at("EETN 050950Z NIL", "EE").text, "UNKN")
})

test("the rule set can be forced, ignoring the country", () => {
  const raw = "EETN 050950Z 09004KT 4000 BKN020 10/08 Q1013"
  const forced = C.categorize(M.parse(raw, { now: NOW }), { country: "EE", ruleSet: "faa", now: NOW })
  assert.equal(forced.ruleSet, "faa")
  assert.equal(forced.text, "IFR", "the same weather SERA calls SVFR")
})

// ---------------------------------------------------- per-field colouring

test("each value can be banded on its own, for the row colours", () => {
  assert.equal(C.bandFor(9999, "visibility", "sera").key, "vmc")
  assert.equal(C.bandFor(4000, "visibility", "sera").key, "svfr")
  assert.equal(C.bandFor(1200, "visibility", "sera").key, "imc")
  assert.equal(C.bandFor(2000, "ceiling", "sera").key, "vmc")
  assert.equal(C.bandFor(800, "ceiling", "sera").key, "svfr")
  assert.equal(C.bandFor(400, "ceiling", "sera").key, "imc")
  assert.equal(C.bandFor(null, "ceiling", "sera"), null)
})

console.log(`category.test.js: ${passed} passed`)
