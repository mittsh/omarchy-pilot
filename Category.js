// Flight-weather categories.
//
// Two rule sets, because there is no single worldwide scheme.
//
// The FAA publishes VFR / MVFR / IFR / LIFR. Europe does not. A full-text
// search of the EASA Easy Access Rules for SERA (275 pages, the consolidated
// Regulation (EU) 923/2012) finds zero occurrences of MVFR and zero of LIFR.
// They are a US charting convention, and not regulatory even there: FAA
// AC 00-45H says they "are not flight rules ... created for weather charts as
// a means to visually enhance the products."
//
// What Europe does define is a binary — VMC or IMC — plus two numeric gates
// that apply at an aerodrome and are computable from a METAR. Those gates are
// this module's European rule set, and unlike the FAA bands they are
// regulatory, quotable, and expressed in the units a European METAR uses.
//
// Pure functions. The caller supplies the clock and the ISO country.

// ------------------------------------------------------------- the rule sets

// Two label styles for the same three bands. VMC and IMC are the terms
// European regulation actually uses, and are the default. VFR and IFR are
// what most pilots say out loud, so they are offered as an alternative. The
// thresholds are identical either way — only the wording changes.
//
// SERA.5005(b): "VFR flights shall not take off or land at an aerodrome
// within a control zone, or enter the aerodrome traffic zone or aerodrome
// traffic circuit when the reported meteorological conditions at that
// aerodrome are below the following minima: (1) the ceiling is less than
// 450 m (1 500 ft); or (2) the ground visibility is less than 5 km."
//
// SERA.5010(c): an ATC unit "shall not issue a special VFR clearance ...
// when the reported meteorological conditions at that aerodrome are below
// the following minima: (1) the ground visibility is less than 1 500 m ...;
// (2) the ceiling is less than 180 m (600 ft)."
var SERA = {
  id: "sera",
  source: "SERA.5005(b), SERA.5010(c)",
  bands: [
    { key: "vmc",  slot: "vfr",  text: "VMC",  textAlt: "VFR",  detail: "VFR",
      minCeilingFt: 1500, minVisibilityM: 5000 },
    { key: "svfr", slot: "svfr", text: "SVFR", textAlt: "SVFR", detail: "Special VFR only",
      minCeilingFt: 600, minVisibilityM: 1500 },
    { key: "imc",  slot: "ifr",  text: "IMC",  textAlt: "IFR",  detail: "IFR only",
      minCeilingFt: null, minVisibilityM: null }
  ]
}

// FAA AIM 7-1-7, verbatim thresholds. The bands are listed best first and
// each states the floor it must clear, so one comparison loop serves both
// rule sets.
//
//   VFR   ceiling greater than 3000 ft and visibility greater than 5 sm
//   MVFR  ceiling 1000 to 3000 ft and/or visibility 3 to 5 sm inclusive
//   IFR   ceiling 500 to less than 1000 ft and/or visibility 1 to less than 3
//   LIFR  ceiling less than 500 ft and/or visibility less than 1 mile
var SM = 1609.344

// The floors are rounded to whole metres because Metar.js stores visibility
// that way. Comparing a rounded value against an unrounded floor puts the
// boundary in the wrong place: 5SM stores as 8047 m, which is greater than
// an exact 8046.72 floor, so the report would read VFR when the AIM says
// MVFR. Rounding both sides identically keeps every boundary exact.
function milesToMetres(miles) { return Math.round(miles * SM) }

var FAA = {
  id: "faa",
  source: "FAA AIM 7-1-7",
  bands: [
    { key: "vfr",  slot: "vfr",  text: "VFR",  textAlt: "VFR",  detail: "",
      minCeilingFt: 3000, minVisibilityM: milesToMetres(5), exclusive: true },
    { key: "mvfr", slot: "mvfr", text: "MVFR", textAlt: "MVFR", detail: "Marginal VFR",
      minCeilingFt: 1000, minVisibilityM: milesToMetres(3) },
    { key: "ifr",  slot: "ifr",  text: "IFR",  textAlt: "IFR",  detail: "",
      minCeilingFt: 500, minVisibilityM: milesToMetres(1) },
    { key: "lifr", slot: "lifr", text: "LIFR", textAlt: "LIFR", detail: "Low IFR",
      minCeilingFt: null, minVisibilityM: null }
  ]
}

var RULE_SETS = { sera: SERA, faa: FAA }

// ------------------------------------------------------------ which rule set

// The 31 EASA member states: the 27 EU states plus Iceland, Liechtenstein,
// Norway and Switzerland. There is no machine-readable list, so this is
// transcribed by hand from easa.europa.eu.
var EASA_STATES = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
  "IS", "LI", "NO", "CH"
]

// EU outermost regions. Article 349 TFEU applies EU law in full, so SERA
// applies, but each has its own ISO code and would otherwise be missed.
// Their opposite numbers, the overseas countries and territories, are
// deliberately absent: NC, PF, WF, PM, BL, GL and TF are outside EU law even
// though several are French or Danish.
var EU_OUTERMOST = ["GP", "MQ", "GF", "RE", "YT", "MF"]

// The United Kingdom left EASA on 31 December 2020 but retained SERA as
// assimilated law (SI 2021 No. 10). The numbers used here are unchanged in
// the retained version, so the same bands apply. The crown dependencies and
// the overseas territories listed follow UK CAA oversight.
var UK_RETAINED_SERA = ["GB", "GG", "JE", "IM", "GI", "FK"]

var SERA_COUNTRIES = EASA_STATES.concat(EU_OUTERMOST).concat(UK_RETAINED_SERA)

// A two-letter ISO 3166-1 country code decides the rule set.
//
// The ICAO location-indicator prefix is NOT used, because it is not a sound
// proxy for the regulator. UK is Ukraine. EG spans six jurisdictions
// including the Falklands and British Antarctic Territory. BI Iceland is
// EASA while BG Greenland is Danish and outside the EU. LT is Turkey.
// Martinique (TFFF) is EASA and Tahiti (NTAA) is not, and both are France.
// The Canaries sit in the African G block and are fully EASA.
function ruleSetForCountry(country) {
  var code = String(country || "").trim().toUpperCase()
  if (!code) return null
  return SERA_COUNTRIES.indexOf(code) !== -1 ? SERA : FAA
}

// ------------------------------------------------------------- the decision

var UNKNOWN = {
  key: "unkn", slot: null, text: "UNKN", detail: "Insufficient data",
  ceilingFt: null, visibilityM: null, driver: null, ruleSet: null, reason: null
}

function unknown(reason) {
  var out = {}
  for (var k in UNKNOWN) out[k] = UNKNOWN[k]
  out.reason = reason
  return out
}

// Which band a single value falls into, as an index into bands.
// A null floor is the last band, which everything below reaches.
function bandIndexFor(value, bands, key) {
  for (var i = 0; i < bands.length; i++) {
    var floor = bands[i][key]
    if (floor === null) return i
    // The FAA VFR band alone is "greater than", not "at or above": a ceiling
    // of exactly 3000 ft is MVFR, and exactly 5 sm is MVFR.
    var clears = bands[i].exclusive ? value > floor : value >= floor
    if (clears) return i
  }
  return bands.length - 1
}

// report      a parsed METAR from Metar.js
// options     { country, ruleSet, now, maxAgeMinutes }
//
//   country        ISO 3166-1 alpha-2. Chooses the rule set.
//   ruleSet        "sera" or "faa" to override the country entirely.
//   labels         "vmc" (default) or "vfr", the wording of the SERA bands.
//   now            the clock, for the staleness check.
//   maxAgeMinutes  a report older than this gives UNKN. Default 180.
//
// Returns the winning band, plus the two values that produced it and which
// of them drove the result.
function categorize(report, options) {
  var opts = options || {}
  if (!report) return unknown("no report")
  if (report.nil) return unknown("report is NIL")

  var rules = opts.ruleSet ? RULE_SETS[String(opts.ruleSet).toLowerCase()]
                           : ruleSetForCountry(opts.country)
  if (!rules) return unknown("country unknown, cannot choose a rule set")

  // A stale observation is worse than no observation, because it looks
  // current. This is not hypothetical: the NOAA feed has been seen serving a
  // seventeen-day-old report for EEEI while still assigning it a category.
  if (opts.now && report.time) {
    var maxAge = opts.maxAgeMinutes === undefined ? 180 : opts.maxAgeMinutes
    var reference = opts.now instanceof Date ? opts.now : new Date(opts.now)
    var age = Math.floor((reference.getTime() - report.time.getTime()) / 60000)
    if (age > maxAge) return unknown("report is " + age + " minutes old")
  }

  var ceiling = ceilingFrom(report)
  var visibilityM = report.visibility ? report.visibility.metres : null

  if (!ceiling.known && visibilityM === null) return unknown("no ceiling and no visibility")
  if (!ceiling.known) return unknown("ceiling cannot be determined")
  if (visibilityM === null) return unknown("no visibility reported")

  var bands = rules.bands
  // An unlimited ceiling never constrains, so it takes the best band.
  var ceilingIndex = ceiling.unlimited ? 0 : bandIndexFor(ceiling.ft, bands, "minCeilingFt")
  var visibilityIndex = bandIndexFor(visibilityM, bands, "minVisibilityM")

  // The worse of the two wins. Every threshold in both rule sets is "and/or"
  // except the best band, which is "and" — the same thing seen from the
  // other side.
  var index = Math.max(ceilingIndex, visibilityIndex)
  var band = bands[index]

  var driver = "both"
  if (ceilingIndex > visibilityIndex) driver = "ceiling"
  else if (visibilityIndex > ceilingIndex) driver = "visibility"

  return {
    key: band.key,
    slot: band.slot,
    text: String(opts.labels).toLowerCase() === "vfr" ? band.textAlt : band.text,
    detail: band.detail,
    ceilingFt: ceiling.unlimited ? null : ceiling.ft,
    ceilingUnlimited: ceiling.unlimited,
    visibilityM: visibilityM,
    driver: driver,
    ruleSet: rules.id,
    source: rules.source,
    reason: null
  }
}

// The ceiling, in the three states the decision needs. Uses Metar.ceilingInfo
// when the caller passed a report parsed by this project's decoder, and falls
// back to the plain fields otherwise so a hand-built object still works.
function ceilingFrom(report) {
  if (report.ceiling && typeof report.ceiling === "object") return report.ceiling
  if (report.clouds && typeof ceilingInfoHook === "function") return ceilingInfoHook(report.clouds)
  if (report.ceilingFt !== undefined && report.ceilingFt !== null) {
    return { ft: report.ceilingFt, unlimited: false, known: true }
  }
  return { ft: null, unlimited: false, known: false }
}

// Injected by the caller so this file stays free of imports. Panel.qml and
// the tests both wire Metar.ceilingInfo in.
var ceilingInfoHook = null
function useCeilingInfo(fn) { ceilingInfoHook = fn }

// The band a single value alone would give. Used to colour the visibility
// and ceiling rows independently, so the reader sees which one is binding.
function labelFor(band, labels) {
  if (!band) return ""
  return String(labels).toLowerCase() === "vfr" ? band.textAlt : band.text
}

function bandFor(value, kind, ruleSetId) {
  var rules = RULE_SETS[String(ruleSetId || "faa").toLowerCase()]
  if (!rules || value === null || value === undefined) return null
  var key = kind === "ceiling" ? "minCeilingFt" : "minVisibilityM"
  return rules.bands[bandIndexFor(value, rules.bands, key)]
}

if (typeof module !== "undefined") {
  module.exports = {
    categorize: categorize,
    ruleSetForCountry: ruleSetForCountry,
    bandFor: bandFor,
    labelFor: labelFor,
    bandIndexFor: bandIndexFor,
    useCeilingInfo: useCeilingInfo,
    SERA: SERA,
    FAA: FAA,
    RULE_SETS: RULE_SETS,
    SERA_COUNTRIES: SERA_COUNTRIES,
    EASA_STATES: EASA_STATES,
    SM: SM
  }
}
