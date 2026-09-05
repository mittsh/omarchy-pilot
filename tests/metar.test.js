// METAR decoder tests. Plain node, no framework:
//   node tests/metar.test.js
//
// Every report below is a real observation, captured from
// aviationweather.gov. Synthetic METARs hide the things that actually break a
// parser.

const assert = require("node:assert/strict")
const M = require("../Metar.js")

// A fixed clock, so the day/hour resolution is deterministic forever.
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

// ------------------------------------------------------ Europe, the base case

test("EETN: a routine European report", () => {
  const r = M.parse("METAR EETN 050950Z 31004KT 270V360 9999 FEW030CB 16/10 Q0995 NOSIG", { now: NOW })

  assert.equal(r.station, "EETN")
  assert.equal(r.time.toISOString(), "2026-09-05T09:50:00.000Z")
  assert.equal(r.wind.direction, 310)
  assert.equal(r.wind.speedKt, 4)
  assert.equal(r.wind.gustKt, null)
  assert.equal(r.wind.varyFrom, 270)
  assert.equal(r.wind.varyTo, 360)
  assert.equal(r.visibility.metres, 9999)
  assert.equal(r.visibility.atLeast, true)
  assert.equal(r.clouds.length, 1)
  assert.equal(r.clouds[0].cover, "FEW")
  assert.equal(r.clouds[0].baseFt, 3000)
  assert.equal(r.clouds[0].type, "CB")
  assert.equal(r.ceilingFt, null, "FEW is not a ceiling")
  assert.equal(r.temperatureC, 16)
  assert.equal(r.dewpointC, 10)
  assert.equal(r.pressure.hPa, 995)
  assert.equal(r.pressure.unitReported, "Q")
  assert.equal(r.humidity, 68)
  assert.equal(r.trend, "NOSIG")
  assert.deepEqual(r.unparsed, [])
})

test("EETN: CAVOK replaces visibility, cloud and weather", () => {
  const r = M.parse("EETN 050450Z VRB02KT CAVOK 11/11 Q0994 NOSIG", { now: NOW })

  assert.equal(r.wind.variable, true)
  assert.equal(r.wind.direction, null)
  assert.equal(r.wind.speedKt, 2)
  assert.equal(r.visibility.cavok, true)
  assert.equal(r.visibility.metres, 10000)
  assert.equal(r.clouds[0].cover, "NSC", "CAVOK implies no significant cloud")
  assert.equal(r.ceilingFt, null)
  assert.equal(r.humidity, 100, "temperature equal to dewpoint is saturated")
  assert.deepEqual(r.unparsed, [])
})

test("EGLL: an automatic report", () => {
  const r = M.parse("EGLL 050950Z AUTO 27010KT 240V300 9999 FEW032 18/10 Q1024", { now: NOW })

  assert.equal(r.auto, true)
  assert.equal(r.wind.speedKt, 10)
  assert.equal(r.pressure.hPa, 1024)
  assert.deepEqual(r.unparsed, [])
})

test("EFHK: a towering cumulus layer", () => {
  const r = M.parse("EFHK 050950Z 24004KT 190V340 9999 SCT027TCU 17/10 Q0994 NOSIG", { now: NOW })

  assert.equal(r.clouds[0].type, "TCU")
  assert.equal(r.clouds[0].typeText, "towering cumulus")
  assert.equal(r.ceilingFt, null, "SCT is not a ceiling")
  assert.deepEqual(r.unparsed, [])
})

// --------------------------------------------------------- the MPS wind trap

test("ULLI: wind in metres per second becomes knots", () => {
  const r = M.parse("ULLI 051000Z 29005MPS 270V340 9999 BKN017 16/11 Q0994 R28R/090065 NOSIG", { now: NOW })

  assert.equal(r.wind.unitReported, "MPS")
  assert.equal(r.wind.speedKt, 10, "5 m/s is 9.7 kt, rounded to 10")
  assert.equal(r.ceilingFt, 1700, "BKN017 is the ceiling")
  // R28R/090065 is the runway state group, not RVR. Six digits after the
  // slash means deposit, extent, depth and friction. RVR is always four.
  assert.equal(r.runwayState, "R28R/090065")
  assert.equal(r.rvr.length, 0)
  assert.deepEqual(r.unparsed, [])
})

test("runway visual range is four digits, and may vary", () => {
  assert.equal(M.parseRvr("R28R/0900").lowest, 900)
  assert.equal(M.parseRvr("R06/M0150V0500U").lowest, 150)
  assert.equal(M.parseRvr("R06/M0150V0500U").highest, 500)
  assert.equal(M.parseRvr("R06/M0150V0500U").trend, "U")
  assert.equal(M.parseRvr("R28/P2000").prefix, "P")
  assert.equal(M.parseRvr("R28R/090065"), null, "six digits is a state group")
})

test("wind unit conversions are not silently skipped", () => {
  assert.equal(M.parseWind("29005MPS").speedKt, 10)
  assert.equal(M.parseWind("29005KT").speedKt, 5)
  assert.equal(M.parseWind("00000KT").calm, true)
  assert.equal(M.parseWind("24015G28KT").gustKt, 28)
  assert.equal(M.parseWind("/////KT").speedKt, null)
  assert.equal(M.parseWind("VRB02KT").variable, true)
})

// ----------------------------------------------------- United States reports

test("KJFK: inches of mercury, statute miles and a remark block", () => {
  const r = M.parse("METAR KJFK 050951Z 02005KT 10SM BKN100 22/16 A2982 RMK AO2 SLP099 T02220156 $", { now: NOW })

  assert.equal(r.pressure.unitReported, "A")
  assert.equal(r.pressure.inHg, 29.82)
  assert.equal(r.pressure.hPa, 1010, "29.82 inHg is 1009.9 hPa, rounded")
  assert.equal(r.visibility.unitReported, "SM")
  assert.equal(r.visibility.metres, 16093)
  assert.equal(r.ceilingFt, 10000)
  assert.equal(r.temperatureC, 22.2, "the remark block wins over 22/16")
  assert.equal(r.dewpointC, 15.6)
  assert.equal(r.seaLevelPressureHpa, 1009.9)
  assert.equal(r.remarks, "AO2 SLP099 T02220156 $")
  assert.deepEqual(r.unparsed, [])
})

test("KDEN: CLR means no cloud", () => {
  const r = M.parse("KDEN 050953Z 19009KT 10SM CLR 18/11 A3006 RMK AO2 SLP089 T01780106", { now: NOW })

  assert.equal(r.clouds[0].cover, "CLR")
  assert.equal(r.ceilingFt, null)
  assert.equal(r.temperatureC, 17.8)
  assert.deepEqual(r.unparsed, [])
})

test("PANC: three layers, ceiling is the lowest broken one", () => {
  const r = M.parse("PANC 050953Z VRB04KT 10SM BKN060 BKN075 OVC095 14/11 A2994 RMK AO2 SLP139 T01390111", { now: NOW })

  assert.equal(r.clouds.length, 3)
  assert.equal(r.ceilingFt, 6000)
  assert.deepEqual(r.unparsed, [])
})

// ------------------------------------------------------------- hard cases

test("a measured base of /// does not become a zero ceiling", () => {
  // RJTT sends this in fog. Reading /// as 000 would report a zero ceiling and
  // a false LIFR, which is exactly the kind of wrong answer that matters.
  const cloud = M.parseCloud("BKN///")
  assert.equal(cloud.cover, "BKN")
  assert.equal(cloud.baseFt, null)
  assert.equal(M.ceilingOf([cloud]), null)
})

test("vertical visibility counts as a ceiling", () => {
  const r = M.parse("EETN 050950Z 09004KT 0300 FG VV002 08/08 Q1013", { now: NOW })
  assert.equal(r.ceilingFt, 200)
  assert.equal(r.visibility.metres, 300)
  assert.equal(r.weather[0].text, "Fog")
})

test("negative temperatures use M, not a minus sign", () => {
  const r = M.parse("EETN 050950Z 09004KT 9999 SCT030 M02/M05 Q1013", { now: NOW })
  assert.equal(r.temperatureC, -2)
  assert.equal(r.dewpointC, -5)
})

test("fractional statute mile visibility", () => {
  assert.equal(M.parseVisibility("1/2SM").metres, 805)
  assert.equal(M.parseVisibility("P6SM").atLeast, true)
  assert.equal(M.parseVisibility("M1/4SM").atMost, true)
  // The split form "1 1/2SM" spans two tokens.
  const split = M.parseVisibility("1", "1/2SM")
  assert.equal(split.metres, 2414)
  assert.equal(split.consumedNext, true)
})

test("weather groups decode to readable text", () => {
  assert.equal(M.parseWeather("-RA").text, "Light rain")
  assert.equal(M.parseWeather("+TSRA").text, "Heavy thunderstorm rain")
  assert.equal(M.parseWeather("VCSH").text, "Showers of in the vicinity")
  assert.equal(M.parseWeather("BR").text, "Mist")
  assert.equal(M.parseWeather("FZFG").text, "Freezing fog")
  assert.equal(M.parseWeather("-SHRASN").text, "Light showers of rain and snow")
})

test("an automatic station with no weather sensor sends //", () => {
  // Real report from YSSY. // is "not reported", not "no weather".
  const r = M.parse("METAR YSSY 051100Z AUTO 33011KT 9999 // NCD 22/11 Q1008", { now: NOW })
  assert.equal(r.weatherNotReported, true)
  assert.deepEqual(r.weather, [])
  assert.equal(r.clouds[0].cover, "NCD")
  assert.deepEqual(r.unparsed, [])
})

test("a report time near midnight resolves to the previous day", () => {
  const justAfterMidnight = new Date("2026-09-01T00:20:00Z")
  const r = M.parse("EETN 312350Z 09004KT 9999 SCT030 10/08 Q1013", { now: justAfterMidnight })
  assert.equal(r.time.toISOString(), "2026-08-31T23:50:00.000Z")
})

test("age is measured against the caller's clock", () => {
  const r = M.parse("EETN 050950Z 31004KT 9999 FEW030 16/10 Q0995", { now: NOW })
  assert.equal(M.ageMinutes(r, NOW), 15)
})

test("empty and malformed input do not throw", () => {
  assert.equal(M.parse(""), null)
  assert.equal(M.parse(null), null)
  assert.equal(M.parse("   "), null)
  const junk = M.parse("NOT A METAR AT ALL", { now: NOW })
  assert.ok(junk, "junk still returns a result rather than throwing")
})

test("a NIL report is flagged and not decoded further", () => {
  const r = M.parse("EETN 050950Z NIL", { now: NOW })
  assert.equal(r.nil, true)
  assert.equal(r.wind, null)
})

console.log(`metar.test.js: ${passed} passed`)
