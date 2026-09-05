// Display formatting tests.
//
//   node tests/format.test.js
//
// The exact strings matter. "10 km+" and "None" are metar-taf.com's wording
// and read better than a converted number or a dash, so they are pinned here.

const assert = require("node:assert/strict")
const M = require("../Metar.js")
const C = require("../Category.js")
const F = require("../Format.js")

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

const parse = (raw) => M.parse(raw, { now: NOW })

test("wind keeps the variable sector and the gust", () => {
  assert.equal(F.wind(parse("EETN 050950Z 31004KT 270V360 9999 SCT030 16/10 Q0995")),
    "310° (270-360°)  4 kt")
  assert.equal(F.wind(parse("EETN 050950Z 24015G28KT 9999 SCT030 16/10 Q0995")),
    "240°  15 kt gusting 28")
  assert.equal(F.wind(parse("EETN 050950Z VRB02KT 9999 SCT030 16/10 Q0995")),
    "Variable 2 kt")
  assert.equal(F.wind(parse("EETN 050950Z 00000KT 9999 SCT030 16/10 Q0995")), "Calm")
})

test("visibility is shown in the unit the station reported", () => {
  // Converting is what makes two tools disagree about the same weather.
  assert.equal(F.visibility(parse("EETN 050950Z 09004KT 9999 SCT030 16/10 Q0995")), "10 km+")
  assert.equal(F.visibility(parse("EETN 050950Z 09004KT 4000 SCT030 16/10 Q0995")), "4 km")
  assert.equal(F.visibility(parse("EETN 050950Z 09004KT 0800 FG SCT030 16/10 Q0995")), "800 m")
  assert.equal(F.visibility(parse("EETN 050450Z VRB02KT CAVOK 11/11 Q0994")), "CAVOK")
  assert.equal(F.visibility(parse("KJFK 050951Z 02005KT 10SM BKN100 22/16 A2982")), "10 sm")
  assert.equal(F.visibility(parse("KJFK 050951Z 02005KT 1/2SM BKN100 22/16 A2982")), "1/2 sm")
})

test("clouds list every layer with its type", () => {
  assert.equal(F.clouds(parse("EETN 050950Z 09004KT 9999 SCT023 FEW030CB 16/10 Q0995")),
    "SCT 2,300 ft, FEW 3,000 ft CB")
  assert.equal(F.clouds(parse("KDEN 050953Z 19009KT 10SM CLR 18/11 A3006")), "Clear")
  assert.equal(F.clouds(parse("EETN 050450Z VRB02KT CAVOK 11/11 Q0994")), "No significant cloud")
})

test("ceiling says None, Unknown or a height", () => {
  const at = (raw, country) => C.categorize(parse(raw), { country, now: NOW })
  assert.equal(F.ceiling(at("EETN 050950Z 09004KT 9999 SCT030 16/10 Q0995", "EE")), "None")
  assert.equal(F.ceiling(at("EETN 050950Z 09004KT 9999 BKN012 16/10 Q0995", "EE")), "1,200 ft")
  // A ceiling that could not be measured must not read as a number.
  assert.equal(F.ceiling(at("EDDV 050950Z 09004KT 9999 BKN///TCU 16/10 Q0995", "DE")), "Unknown")
})

test("pressure shows hectopascals, and both units for a US report", () => {
  assert.equal(F.pressure(parse("EETN 050950Z 09004KT 9999 SCT030 16/10 Q0995")), "995 hPa")
  assert.equal(F.pressure(parse("KJFK 050951Z 02005KT 10SM BKN100 22/16 A2982")),
    "1010 hPa (29.82 inHg)")
})

test("temperature keeps the tenths the US remark block gives", () => {
  assert.equal(F.temperature(parse("EETN 050950Z 09004KT 9999 SCT030 16/10 Q0995")), "16 / 10 °C")
  assert.equal(F.temperature(parse("EETN 050950Z 09004KT 9999 SCT030 M02/M05 Q0995")), "-2 / -5 °C")
  assert.equal(F.temperature(parse("KDEN 050953Z 19009KT 10SM CLR 18/11 A3006 RMK T01780106")),
    "17.8 / 10.6 °C")
})

test("age reads in the largest sensible unit", () => {
  assert.equal(F.age(0), "0m")
  assert.equal(F.age(45), "45m")
  assert.equal(F.age(90), "1h 30m")
  assert.equal(F.age(1500), "1d 1h")
  assert.equal(F.age(null), "—")
})

test("age level flags a report that should have been replaced", () => {
  // A routine METAR is hourly. Past 40 minutes one is due; past 90 one has
  // been missed.
  assert.equal(F.ageLevel(20), "ok")
  assert.equal(F.ageLevel(40), "warn")
  assert.equal(F.ageLevel(90), "bad")
  assert.equal(F.ageLevel(null), "unknown")
})

test("the row set carries a band slot for visibility and ceiling only", () => {
  const report = parse("EETN 050950Z 09004KT 4000 BKN010 16/10 Q0995")
  const category = C.categorize(report, { country: "EE", now: NOW })
  const rows = F.rows(report, category, { visibility: "svfr", ceiling: "svfr" })

  const labels = rows.map((r) => r.label)
  assert.deepEqual(labels, ["Wind", "Visibility", "Clouds", "Ceiling", "Temp/Dew", "Humidity", "QNH"])
  assert.equal(rows.find((r) => r.label === "Visibility").slot, "svfr")
  assert.equal(rows.find((r) => r.label === "Wind").slot, undefined)
})

test("a weather group appears as a row only when there is weather", () => {
  const wet = parse("EETN 050950Z 09004KT 4000 +SHRA BKN010 16/10 Q0995")
  assert.equal(F.weather(wet), "Heavy showers of rain")
  const dry = parse("EETN 050950Z 09004KT 9999 SCT030 16/10 Q0995")
  assert.equal(F.weather(dry), "")
  assert.ok(!F.rows(dry, null, {}).some((r) => r.label === "Weather"))
})

test("times are shown local and zulu", () => {
  const report = parse("EETN 050950Z 09004KT 9999 SCT030 16/10 Q0995")
  assert.equal(F.zuluTime(report.time), "09:50Z")
  assert.match(F.localTime(report.time), /^\d{2}:\d{2}$/)
})

console.log(`format.test.js: ${passed} passed`)
