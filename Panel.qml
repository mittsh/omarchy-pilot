import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Metar.js" as Metar
import "Category.js" as Category
import "Format.js" as Format
import "Sources.js" as Sources
import "Stations.js" as Stations
import "Taf.js" as Taf
import "Theme.js" as Theme

// Omarchy Pilot — aviation weather for one aerodrome.
//
// The bar pill shows the ICAO code and the conditions band. The popup shows
// the decoded METAR, the raw METAR, and the raw TAF.
//
// All decoding lives in the .js files, which are pure and unit tested. This
// file owns only the fetching, the state, and the drawing.

Panel {
  id: root
  moduleName: "pilot.metar"
  ipcTarget: "pilot.metar"
  manageIpc: false

  // ------------------------------------------------------------- settings

  // Set with `omarchy bar set pilot.metar icao EETN`, or from the field in
  // the panel. Both write the same entry in shell.json.
  // A 4-letter code, or "auto" to take the nearest aerodrome. Resolving
  // "auto" writes the code it found back into this setting, so the lookup
  // happens once and the answer is visible and overridable.
  //
  // An UNSET code deliberately does NOT mean "auto". Finding the nearest
  // aerodrome can reach a third-party geolocation service, and that must
  // never happen to somebody who merely enabled the widget and has not asked
  // for anything. Unset shows a prompt instead.
  readonly property string icaoSetting: String(root.setting("icao", "")).toUpperCase().trim()
  readonly property bool wantsNearest: icaoSetting === "AUTO" || icaoSetting === "NEAREST"
  readonly property string icao: wantsNearest ? resolvedIcao : icaoSetting
  readonly property int refreshMinutes: Math.max(1, parseInt(root.setting("refreshMinutes", 10), 10) || 10)
  // "auto" follows the aerodrome's country. "sera" or "faa" forces one.
  readonly property string ruleSetOverride: String(root.setting("rules", "auto")).toLowerCase()

  // "icao" (default), "metric" or "us". Only the decoded rows follow it; the
  // raw report is always quoted verbatim.
  readonly property string unitSet: String(root.setting("units", "icao")).toLowerCase()

  // "vmc" (default) prints the terms European regulation uses. "vfr" prints
  // what most pilots say. The thresholds are identical either way.
  readonly property string labelStyle: String(root.setting("labels", "vmc")).toLowerCase()

  // ---------------------------------------------------------------- state

  property string rawMetar: ""
  property string rawTaf: ""
  property string errorText: ""
  property string resolvedIcao: ""    // filled when "auto" is resolved
  property string nearestNote: ""     // how far away it turned out to be
  property int sourceIndex: 0         // which source in the chain is in use
  property var responses: ({})        // this attempt's replies, by key
  property var pending: []            // requests left in this attempt
  property int tick: 0                // bumped every minute, to re-age the display

  readonly property var report: rawMetar ? Metar.parse(rawMetar, { now: new Date() }) : null
  // From the bundled table: no network call, and better names than the
  // weather API gives. It calls EETN "Tallin Arpt".
  readonly property var station: icao ? Stations.lookup(icao) : null
  readonly property string country: station ? station.country : ""
  readonly property string siteName: station ? station.name : ""

  readonly property var category: {
    tick   // re-evaluate as the report ages past the staleness limit
    if (!report) return null
    Category.useCeilingInfo(Metar.ceilingInfo)
    return Category.categorize(report, {
      country: root.country,
      ruleSet: root.ruleSetOverride === "auto" ? "" : root.ruleSetOverride,
      labels: root.labelStyle,
      now: new Date()
    })
  }

  readonly property int ageMinutes: {
    tick
    return report ? Metar.ageMinutes(report, new Date()) : -1
  }

  // ------------------------------------------------------------- theming
  //
  // Everything below binds to Color and Style, which the shell reassigns on a
  // theme switch, so these follow the theme with no extra code.

  // Ui/Panel does not define these; only Ui/BarWidget does. A bar pill needs
  // them, so they are lifted off the host here.
  readonly property bool vertical: bar ? bar.vertical : false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color dim: Util.alpha(foreground, 0.62)
  readonly property color fainter: Util.alpha(foreground, 0.35)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // Theme.js works in "#rrggbb" strings so it can be tested under node.
  function hexOf(c) {
    function part(v) {
      var n = Math.round(v * 255).toString(16)
      return n.length < 2 ? "0" + n : n
    }
    return "#" + part(c.r) + part(c.g) + part(c.b)
  }

  readonly property var themeFallbacks: ({
    foreground: hexOf(Color.foreground),
    background: hexOf(Color.background),
    accent: hexOf(Color.accent),
    urgent: hexOf(Color.urgent)
  })

  property var palette: ({})

  readonly property var bandSlots: category && category.ruleSet === "sera"
    ? Theme.SCHEME_SLOTS.sera : Theme.SCHEME_SLOTS.faa

  readonly property var badge: category
    ? Theme.badge(category.slot || "", category.text, palette, themeFallbacks, bandSlots)
    : { fill: hexOf(Color.muted), label: "#ffffff", text: "—" }

  // Resolved on their own chains, because the FAA slot list has no yellow and
  // the age warning needs one under both schemes.
  readonly property color warnColor: {
    var c = Theme.badgeColors(palette, themeFallbacks, ["svfr"])
    return c.svfr || Color.accent
  }

  readonly property color alarmColor: {
    var c = Theme.badgeColors(palette, themeFallbacks, ["ifr"])
    return c.ifr || Color.urgent
  }

  // The colour for one value banded on its own, so the reader sees which of
  // ceiling and visibility is driving the result.
  function slotColor(slot) {
    if (!slot) return foreground
    var colors = Theme.badgeColors(palette, themeFallbacks, bandSlots)
    return colors[slot] || foreground
  }

  readonly property var rowSlots: {
    if (!category || !report || category.key === "unkn") return ({})
    var rules = category.ruleSet
    var vis = Category.bandFor(report.visibility ? report.visibility.metres : null, "visibility", rules)
    var ceil = category.ceilingUnlimited
      ? Category.RULE_SETS[rules].bands[0]
      : Category.bandFor(category.ceilingFt, "ceiling", rules)
    return { visibility: vis ? vis.slot : null, ceiling: ceil ? ceil.slot : null }
  }

  readonly property var rows: report ? Format.rows(report, category, rowSlots, unitSet) : []

  // Resolved separately from `category`, because an UNKN observation still
  // leaves a perfectly good forecast to band.
  readonly property string ruleSetId: {
    if (ruleSetOverride !== "auto") return ruleSetOverride
    var rules = Category.ruleSetForCountry(country)
    return rules ? rules.id : ""
  }

  readonly property var taf: rawTaf ? Taf.parse(rawTaf, { now: new Date() }) : null

  readonly property var tafHours: {
    tick
    if (!taf || !ruleSetId) return []
    return Taf.timeline(taf, { ruleSet: ruleSetId, labels: labelStyle, hours: 24 })
  }

  readonly property var tafLines: taf ? Taf.rawLines(taf) : []

  // The hour block the clock is in, so the strip can show where "now" falls.
  readonly property int nowIndex: {
    tick
    if (tafHours.length === 0) return -1
    var ms = new Date().getTime()
    for (var i = 0; i < tafHours.length; i++) {
      if (ms < tafHours[i].time.getTime() + 3600000) return ms >= tafHours[i].time.getTime() ? i : -1
    }
    return -1
  }

  // The pure modules take their collaborators by injection rather than by
  // import, so they stay loadable under node.
  Component.onCompleted: {
    Category.useCeilingInfo(Metar.ceilingInfo)
    Taf.useMetar(Metar)
    Taf.useCategory(Category)
  }

  // The theme directory is destroyed and replaced by omarchy-theme-set, so a
  // watch on colors.toml dies on the first switch. theme.name is rewritten in
  // place, so its watch survives and fires after the swap. See docs/PLAN.md.
  FileView {
    id: themeColors
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: false
    printErrors: false
    onLoaded: root.palette = Theme.parseColorsToml(text())
    onLoadFailed: root.palette = ({})
  }

  FileView {
    path: Color.home + "/.local/state/omarchy/current/theme.name"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: themeColors.reload()
    onLoadFailed: themeColors.reload()
  }

  // --------------------------------------------------------------- fetching

  readonly property string userAgent: "omarchy-pilot/0.1 (https://github.com/mittsh/omarchy-pilot)"

  // NOAA blocks unidentified automated traffic and api.met.no returns 403
  // without an agent, so it is never optional. -fsS keeps curl silent on
  // success and on an HTTP error alike.
  function curl(url) {
    return ["curl", "-fsS", "--max-time", "10", "-A", root.userAgent, url]
  }

  function refresh() {
    if (wantsNearest && resolvedIcao === "") { resolveNearest(); return }
    if (icao.length !== 4) {
      errorText = "Set an ICAO code, or set it to auto for the nearest"
      return
    }
    startSource(0)
  }

  // Try each source in turn. A source that answers with nothing — which is
  // what an unknown code gets from the first one, as HTTP 204 — falls
  // through rather than blanking the panel.
  function startSource(index) {
    if (fetchProc.running) return
    if (index >= Sources.count()) {
      errorText = "No data for " + icao + " from any source"
      return
    }
    sourceIndex = index
    responses = ({})
    pending = Sources.list()[index].requests(icao).slice()
    runNext()
  }

  function runNext() {
    if (pending.length === 0) { finishSource(); return }
    var request = pending[0]
    // Built here rather than bound, because a binding is evaluated lazily:
    // starting the process could otherwise use the previous aerodrome's URL
    // and show its name against the new weather.
    fetchProc.command = curl(request.url)
    fetchProc.running = true
  }

  function finishSource() {
    var source = Sources.list()[sourceIndex]
    var result = source.combine(responses)

    if (!Sources.isUsable(result)) { startSource(sourceIndex + 1); return }

    errorText = ""
    rawMetar = result.metar
    rawTaf = result.taf
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var request = root.pending.shift()
        if (request) {
          var next = {}
          for (var key in root.responses) next[key] = root.responses[key]
          next[request.key] = String(this.text || "")
          root.responses = next
        }
        root.runNext()
      }
    }
  }

  // ------------------------------------------------------ nearest aerodrome
  //
  // Only ever runs when the user asked for it, by leaving `icao` unset or
  // setting it to "auto". The position comes from the least invasive source
  // available, and the resolved code is written back to the config so the
  // lookup never repeats.

  function resolveNearest() {
    // 1. Coordinates the user set explicitly.
    var lat = parseFloat(root.setting("lat", ""))
    var lon = parseFloat(root.setting("lon", ""))
    if (!isNaN(lat) && !isNaN(lon)) { adoptNearest(lat, lon, "your configured position"); return }

    // 2. The location the Omarchy weather plugin already holds, if any.
    //    Reusing it means no new request and no new service.
    if (weatherLocation && weatherLocation.latitude !== null) {
      adoptNearest(weatherLocation.latitude, weatherLocation.longitude, "your weather location")
      return
    }

    // The weather location is read asynchronously, so on the first run it may
    // simply not have arrived yet. Waiting is right: falling through here
    // would send an IP request on behalf of someone who had already said
    // where they are. The refresh timer comes back every few minutes.
    if (!weatherLocationSettled) return

    // 3. Last resort, and the only one that leaves this machine.
    if (!geoProc.running) {
      geoProc.command = curl("https://ipapi.co/json/")
      geoProc.running = true
    }
  }

  property var weatherLocation: null
  property bool weatherLocationSettled: false

  // Resolve as soon as the file settles, rather than waiting for the next
  // refresh tick.
  onWeatherLocationSettledChanged: if (wantsNearest && resolvedIcao === "") resolveNearest()

  FileView {
    path: Color.home + "/.local/state/omarchy/settings/weather.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var data = JSON.parse(text())
        var lat = parseFloat(data.latitude)
        var lon = parseFloat(data.longitude)
        root.weatherLocation = (isNaN(lat) || isNaN(lon)) ? null : { latitude: lat, longitude: lon }
      } catch (e) {
        root.weatherLocation = null
      }
      root.weatherLocationSettled = true
    }
    // No file at all is a settled answer: the weather plugin is in
    // auto-detect mode and holds no coordinates to borrow.
    onLoadFailed: {
      root.weatherLocation = null
      root.weatherLocationSettled = true
    }
  }

  Process {
    id: geoProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var data = JSON.parse(String(this.text || "{}"))
          var lat = parseFloat(data.latitude)
          var lon = parseFloat(data.longitude)
          if (isNaN(lat) || isNaN(lon)) { root.errorText = "Could not find your position"; return }
          root.adoptNearest(lat, lon, "your approximate location")
        } catch (e) {
          root.errorText = "Could not find your position"
        }
      }
    }
  }

  // Search the bundled table, not the network. Prefer an aerodrome that also
  // issues a forecast, since half the panel is the TAF; fall back to any.
  function adoptNearest(lat, lon, sourceText) {
    var found = Stations.nearest(lat, lon, { limit: 1, requireTaf: true, maxKm: 400 })
    if (found.length === 0) found = Stations.nearest(lat, lon, { limit: 1, maxKm: 400 })
    if (found.length === 0) {
      errorText = "No aerodrome within 400 km"
      return
    }

    var pick = found[0]
    resolvedIcao = pick.station.icao
    nearestNote = pick.distanceKm + " km from " + sourceText
    errorText = ""
    // Persist it, so the lookup happens once and the answer is visible.
    commitIcao(pick.station.icao)
    startSource(0)
  }

  onIcaoChanged: {
    rawMetar = ""
    rawTaf = ""
    errorText = ""
    sourceIndex = 0
    if (icao.length === 4) startSource(0)
  }

  Timer {
    interval: root.refreshMinutes * 60 * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // Re-age the display without refetching. The age shown must keep counting.
  Timer {
    interval: 60000
    running: true
    repeat: true
    onTriggered: root.tick++
  }

  // -------------------------------------------------------------- the pill

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    refresh()
    Qt.callLater(function () { keyCatcher.forceActiveFocus() })
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refresh(); return "ok" }
    function status(): string {
      return root.icao + " " + (root.category ? root.category.text : "—") + " " + root.rawMetar
    }
  }

  WidgetButton {
    id: button
    bar: root.bar
    labelVisible: false
    hasVisualContent: true
    tooltipText: root.rawMetar || root.errorText
    fixedWidth: root.vertical ? -1 : pill.implicitWidth + scaledHorizontalMargin * 2
    fixedHeight: root.vertical ? pill.implicitHeight + scaledVerticalPadding * 2 : -1

    onPressed: function (code) {
      if (code === Qt.MiddleButton) root.refresh()
      else root.toggle()
    }

    Row {
      id: pill
      anchors.centerIn: parent
      spacing: Style.space(5)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        visible: !root.vertical && root.icao !== ""
        text: root.icao
        color: root.barForeground
        font.family: root.fontFamily
        font.pixelSize: Style.bar.iconFont
      }

      // A filled chip, never coloured text. Coloured text on the bar drops to
      // 2.3:1 in some themes; a chip with a luminance-picked label never
      // falls below 4.66:1. The band is always spelled out, because six
      // shipped themes are effectively monochrome.
      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(3)
        color: root.badge.fill
        implicitWidth: chipText.implicitWidth + Style.space(8)
        implicitHeight: chipText.implicitHeight + Style.space(2)

        Text {
          id: chipText
          anchors.centerIn: parent
          text: root.badge.text
          color: root.badge.label
          font.family: root.fontFamily
          font.pixelSize: Style.bar.iconFont
          font.bold: true
        }
      }
    }
  }

  // ------------------------------------------------------------- the popup

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: icaoField.activeFocus
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }
      onTextKey: function (t) {
        if (t === "r" || t === "R") root.refresh()
        else if (t === "e" || t === "E") icaoField.forceActiveFocus()
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: flick.width
          spacing: Style.space(12)

          // ------------------------------------------------- header

          Item {
            width: parent.width
            implicitHeight: Math.max(identity.implicitHeight, headerBadge.implicitHeight)

            Column {
              id: identity
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              width: parent.width - headerBadge.width - Style.space(10)
              spacing: Style.space(2)

              Text {
                text: root.icao || "No aerodrome set"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.heading
                font.bold: true
              }

              Text {
                visible: text !== ""
                width: parent.width
                text: root.siteName
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                elide: Text.ElideRight
              }
            }

            Rectangle {
              id: headerBadge
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(3)
              color: root.badge.fill
              implicitWidth: headerBadgeText.implicitWidth + Style.space(16)
              implicitHeight: headerBadgeText.implicitHeight + Style.space(8)

              Text {
                id: headerBadgeText
                anchors.centerIn: parent
                text: root.badge.text
                color: root.badge.label
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }
            }
          }

          // ------------------------------------------- time and age

          Row {
            width: parent.width
            spacing: Style.space(6)
            visible: root.report !== null

            Text {
              text: root.report && root.report.time
                ? Format.localTime(root.report.time) + " · " + Format.zuluTime(root.report.time)
                : ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              text: "·"
              color: root.fainter
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            // Age earns its own colour. A stale report looks exactly like a
            // fresh one until this says otherwise.
            Text {
              text: Format.age(root.ageMinutes) + " old"
              color: {
                var level = Format.ageLevel(root.ageMinutes)
                if (level === "bad") return root.alarmColor
                if (level === "warn") return root.warnColor
                return root.dim
              }
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }
          }

          // ------------------------------------- why it is not categorised

          Text {
            width: parent.width
            visible: root.category !== null && root.category.key === "unkn" && root.category.reason
            text: root.category && root.category.reason ? "Not categorised: " + root.category.reason : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: root.nearestNote !== "" && root.wantsNearest
            text: "Nearest: " + root.nearestNote
            color: root.fainter
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            width: parent.width
            visible: root.errorText !== ""
            text: root.errorText
            color: root.alarmColor
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // --------------------------------------------- decoded rows

          Column {
            width: parent.width
            spacing: Style.space(4)
            visible: root.rows.length > 0

            Repeater {
              model: root.rows

              Item {
                width: column.width
                implicitHeight: Math.max(rowLabel.implicitHeight, rowValue.implicitHeight)

                Text {
                  id: rowLabel
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  width: Style.space(78)
                  text: modelData.label
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Text {
                  id: rowValue
                  anchors.left: rowLabel.right
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  text: modelData.value
                  // Visibility and ceiling wear their own band's colour, so
                  // the reader sees which one is binding.
                  color: modelData.slot ? root.slotColor(modelData.slot) : root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  wrapMode: Text.WordWrap
                }
              }
            }
          }

          // ------------------------------------------------ raw METAR

          Rectangle {
            width: parent.width
            visible: root.rawMetar !== ""
            radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(3)
            color: Util.alpha(root.foreground, 0.06)
            border.width: 1
            border.color: Util.alpha(root.foreground, 0.14)
            implicitHeight: metarText.implicitHeight + Style.space(16)

            Text {
              id: metarText
              anchors.fill: parent
              anchors.margins: Style.space(8)
              text: root.rawMetar
              color: root.foreground
              // The same monospace alias as the body. A METAR is read in
              // columns, so a proportional font would be wrong here.
              font.family: root.fontFamily
              // WordWrap, never WrapAnywhere: a raw report is read token by
              // token, and splitting SCT030 into "SCT0 / 30" makes it wrong
              // to the eye.
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          // -------------------------------------------------- the TAF

          Column {
            width: parent.width
            spacing: Style.space(6)
            visible: root.rawTaf !== ""

            Row {
              width: parent.width
              spacing: Style.space(6)

              Text {
                text: "TAF"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.letterSpacing: 1
              }

              Text {
                visible: root.taf !== null && root.taf.validFrom !== null
                text: root.taf && root.taf.validFrom
                  ? Format.zuluTime(root.taf.validFrom) + " → " + Format.zuluTime(root.taf.validTo)
                  : ""
                color: root.fainter
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            // The forecast strip: one block per hour, coloured by the band
            // that hour is forecast to be in. This answers "when does it go
            // bad" in one glance, which no amount of raw text does.
            Item {
              id: strip
              width: parent.width
              height: Style.space(26)
              visible: root.tafHours.length > 0

              readonly property int count: root.tafHours.length
              readonly property real gap: 1
              readonly property real blockWidth: count > 0
                ? (width - gap * (count - 1)) / count : 0

              Row {
                spacing: strip.gap

                Repeater {
                  model: root.tafHours

                  Rectangle {
                    width: strip.blockWidth
                    height: Style.space(18)
                    color: modelData.band ? root.slotColor(modelData.band.slot) : root.fainter
                    // A BECMG window is a period where either the old or the
                    // new conditions may be found. The block already shows
                    // the worse of the two; this dims it to say "in flux".
                    opacity: modelData.changing ? 0.72 : 1.0

                    // A temporary deterioration is a separate channel from
                    // the forecast band, so it gets its own stripe rather
                    // than recolouring the block. Painting a TEMPO as the
                    // forecast would overstate it.
                    Rectangle {
                      visible: modelData.temporary !== null
                      anchors.left: parent.left
                      anchors.right: parent.right
                      anchors.bottom: parent.bottom
                      height: Style.space(5)
                      color: modelData.temporary
                        ? root.slotColor(modelData.temporary.band.slot) : "transparent"
                    }
                  }
                }
              }

              // Where the clock falls in the forecast.
              Rectangle {
                visible: root.nowIndex >= 0
                x: root.nowIndex * (strip.blockWidth + strip.gap)
                width: Math.max(1, strip.blockWidth)
                height: Style.space(18)
                color: "transparent"
                border.width: 1
                border.color: root.foreground
              }

              // Hour ticks, every six hours in UTC.
              Row {
                anchors.bottom: parent.bottom
                spacing: strip.gap

                Repeater {
                  model: root.tafHours

                  Item {
                    width: strip.blockWidth
                    height: Style.space(8)

                    Text {
                      visible: modelData.time.getUTCHours() % 6 === 0
                      text: Format.zuluTime(modelData.time).slice(0, 2)
                      color: root.fainter
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                }
              }
            }

            // Without this the stripe is decoration. With it, it is data.
            Text {
              visible: root.tafHours.length > 0
                && root.tafHours.some(function (h) { return h.temporary !== null })
              width: parent.width
              text: "Lower bar: temporary deterioration possible"
              color: root.fainter
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // The raw forecast, one change group per line, which is how it
            // is read.
            Rectangle {
              width: parent.width
              radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(3)
              color: Util.alpha(root.foreground, 0.06)
              border.width: 1
              border.color: Util.alpha(root.foreground, 0.14)
              implicitHeight: tafColumn.implicitHeight + Style.space(16)

              Column {
                id: tafColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(8)
                spacing: Style.space(2)

                Repeater {
                  model: root.tafLines.length > 0 ? root.tafLines : [root.rawTaf]

                  Text {
                    width: tafColumn.width
                    text: modelData
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    // WordWrap, never WrapAnywhere: a raw report is read
                    // token by token.
                    wrapMode: Text.WordWrap
                  }
                }
              }
            }
          }

          // ------------------------------------------- the ICAO field
          //
          // Omarchy has no settings form: the manifest's settingsForm key is
          // read by nothing in this build. The value is written straight back
          // into this widget's own shell.json entry, the way the clock does.

          Row {
            width: parent.width
            spacing: Style.space(8)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: "ICAO"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            TextField {
              id: icaoField
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(90)
              text: root.icao
              placeholderText: "EETN"
              foreground: root.foreground
              font.family: root.fontFamily
              onAccepted: root.commitIcao(text)
              Keys.onPressed: function (event) {
                if (event.key === Qt.Key_Escape) {
                  text = root.icao
                  keyCatcher.forceActiveFocus()
                  event.accepted = true
                }
              }
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: {
                var parts = []
                if (root.category && root.category.source) parts.push(root.category.source)
                parts.push(Format.unitsFor(root.unitSet).name + " units")
                var source = Sources.list()[root.sourceIndex]
                // Naming the source only when it is a fallback keeps the
                // normal case quiet but makes a degraded one obvious.
                if (root.sourceIndex > 0) parts.push("via " + source.name)
                return parts.join(" · ")
              }
              color: root.fainter
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
                            elide: Text.ElideRight
            }
          }

          // MET Norway's CC BY 4.0 credit is a licence obligation, so it gets
          // its own wrapping line rather than sharing an eliding one, where
          // it would be the first thing to disappear in a narrow panel.
          Text {
            width: parent.width
            visible: text !== ""
            text: Sources.list()[root.sourceIndex].attribution || ""
            color: root.fainter
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }
      }
    }
  }

  // Write the code back into this widget's layout entry in shell.json.
  function commitIcao(value) {
    var next = String(value || "").toUpperCase().trim()
    if (next.length !== 4) return

    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.icao = next

    root.settings = entry
    if (bar && bar.shell && typeof bar.shell.updateEntryInline === "function") {
      bar.shell.updateEntryInline(root.moduleName, entry)
    }
    keyCatcher.forceActiveFocus()
  }
}
