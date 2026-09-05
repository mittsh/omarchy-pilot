// Source chain tests.
//
//   node tests/sources.test.js
//
// The response bodies below are captured verbatim from the three services.
// Each has its own quirk, and each quirk silently corrupts a report if it is
// not handled.

const assert = require("node:assert/strict")
const S = require("../Sources.js")
const M = require("../Metar.js")
const T = require("../Taf.js")
const C = require("../Category.js")

C.useCeilingInfo(M.ceilingInfo)
T.useMetar(M)
T.useCategory(C)

const NOW = new Date("2026-09-05T12:00:00Z")

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

// ------------------------------------------------------- captured bodies

const AWC_BOTH =
`METAR EETN 051150Z 31008KT 280V340 9999 FEW025 SCT030CB 16/10 Q0996 NOSIG
TAF EETN 051130Z 0512/0612 29008KT 9999 FEW025CB SCT030
  TEMPO 0518/0523 4000 SHRA SCT010 SCT020CB BKN045
  BECMG 0523/0601 BKN014`

const TGFTP_METAR =
`2026/09/05 11:50
EETN 051150Z 31008KT 280V340 9999 FEW025 SCT030CB 16/10 Q0996 NOSIG`

const TGFTP_TAF =
`2026/09/05 12:33
TAF TAF EETN 051130Z 0512/0612 29008KT 9999 FEW025CB SCT030
      TEMPO 0518/0523 4000 SHRA SCT010 SCT020CB BKN045
      BECMG 0523/0601 BKN014`

const METNO_METAR =
`EETN 051050Z 32006KT 260V350 9999 SCT022 SCT030CB 16/11 Q0995 NOSIG=
EETN 051120Z 33008KT 300V360 9999 SCT023 FEW030CB 16/10 Q0996 NOSIG=
EETN 051150Z 31008KT 280V340 9999 FEW025 SCT030CB 16/10 Q0996 NOSIG=`

const METNO_TAF =
`EETN 050530Z 0506/0606 VRB02KT 9999 SCT025 TEMPO 0506/0509 BKN004 FEW020CB=
EETN 051130Z 0512/0612 29008KT 9999 FEW025CB SCT030 BECMG 0523/0601 BKN014=`

// ------------------------------------------------------------ the chain

test("the chain is ordered best first", () => {
  const ids = S.list().map((s) => s.id)
  assert.deepEqual(ids, ["awc", "tgftp", "metno"])
  // The first source answers both products in one request; that is why it
  // leads. The last returns 24 hours per call, which is why it trails.
  assert.equal(S.list()[0].requests("EETN").length, 1)
  assert.equal(S.list()[2].requests("EETN").length, 2)
})

test("every source builds https URLs carrying the code", () => {
  for (const source of S.list()) {
    for (const request of source.requests("EETN")) {
      assert.match(request.url, /^https:\/\//, `${source.id} must use https`)
      assert.match(request.url, /EETN/, `${source.id} must name the aerodrome`)
    }
  }
})

test("met.no carries its required attribution", () => {
  // CC BY 4.0. Dropping the credit breaks the licence.
  assert.match(S.byId("metno").attribution, /MET Norway/)
  assert.equal(S.byId("awc").attribution, null, "US federal data is public domain")
})

// -------------------------------------------------- each source's quirk

test("aviationweather.gov: the TAF wraps over several lines", () => {
  const out = S.byId("awc").combine({ both: AWC_BOTH })
  assert.match(out.metar, /^METAR EETN 051150Z/)
  assert.ok(!out.metar.includes("TAF"), "the forecast must not leak into the observation")
  assert.match(out.taf, /^TAF EETN 051130Z/)
  assert.match(out.taf, /BECMG 0523\/0601 BKN014/)
})

test("tgftp: a date header line, and the keyword written twice", () => {
  const out = S.byId("tgftp").combine({ metar: TGFTP_METAR, taf: TGFTP_TAF })
  assert.match(out.metar, /^EETN 051150Z/, "the 2026/09/05 header must go")
  assert.ok(!out.metar.includes("2026/09/05"))
  // "TAF TAF EETN" would leave the decoder a station id of "TAF".
  assert.match(out.taf, /^TAF EETN 051130Z/)
  assert.ok(!out.taf.includes("TAF TAF"))
})

test("met.no: 24 hours of reports, newest last", () => {
  const out = S.byId("metno").combine({ metar: METNO_METAR, taf: METNO_TAF })
  assert.match(out.metar, /^EETN 051150Z/, "the last line is the current report")
  assert.ok(!out.metar.includes("051050Z"), "the older reports must be dropped")
  assert.ok(!out.metar.includes("="), "the terminator must go")
  assert.match(out.taf, /^EETN 051130Z/)
})

// ------------------------------------------- all three agree on the answer

test("all three sources decode to the same weather", () => {
  const results = [
    S.byId("awc").combine({ both: AWC_BOTH }),
    S.byId("tgftp").combine({ metar: TGFTP_METAR, taf: TGFTP_TAF }),
    S.byId("metno").combine({ metar: METNO_METAR, taf: METNO_TAF })
  ]

  const decoded = results.map((r) => M.parse(r.metar, { now: NOW }))
  for (const report of decoded) {
    assert.equal(report.station, "EETN")
    assert.equal(report.wind.speedKt, 8)
    assert.equal(report.pressure.hPa, 996)
    assert.equal(report.visibility.metres, 9999)
    assert.deepEqual(report.unparsed, [], "no source should leave stray tokens")
  }

  const categories = decoded.map((r) => C.categorize(r, { country: "EE", now: NOW }).text)
  assert.deepEqual(categories, ["VMC", "VMC", "VMC"], "the source must not change the answer")
})

test("a TAF from any source resolves into a timeline", () => {
  for (const result of [
    S.byId("awc").combine({ both: AWC_BOTH }),
    S.byId("tgftp").combine({ metar: TGFTP_METAR, taf: TGFTP_TAF }),
    S.byId("metno").combine({ metar: METNO_METAR, taf: METNO_TAF })
  ]) {
    const taf = T.parse(result.taf, { now: NOW })
    assert.equal(taf.station, "EETN", "the station must survive the source's shape")
    assert.ok(T.timeline(taf, { ruleSet: "sera" }).length > 0)
  }
})

// -------------------------------------------------------------- failure

test("an empty body is not a usable answer", () => {
  // An unknown ICAO code returns HTTP 204 with an empty body, not a 404.
  // Treating that as success would leave the panel blank with no fallback.
  assert.equal(S.isUsable(S.byId("awc").combine({ both: "" })), false)
  assert.equal(S.isUsable(S.byId("tgftp").combine({ metar: "", taf: "" })), false)
  assert.equal(S.isUsable(S.byId("metno").combine({ metar: "", taf: "" })), false)
  assert.equal(S.isUsable(null), false)
  assert.equal(S.isUsable({ metar: "short" }), false)
})

test("a header with no report behind it is not usable", () => {
  const out = S.byId("tgftp").combine({ metar: "2026/09/05 11:50\n", taf: "" })
  assert.equal(S.isUsable(out), false)
})

test("a usable answer is recognised", () => {
  assert.equal(S.isUsable(S.byId("awc").combine({ both: AWC_BOTH })), true)
})

test("a missing TAF does not make the observation unusable", () => {
  // Most aerodromes report a METAR and issue no forecast: 7680 stations in
  // the bundled table, only 3591 with a TAF.
  const out = S.byId("tgftp").combine({ metar: TGFTP_METAR, taf: "" })
  assert.equal(S.isUsable(out), true)
  assert.equal(out.taf, "")
})

console.log(`sources.test.js: ${passed} passed`)
