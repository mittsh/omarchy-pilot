import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Metar.js" as Metar
import "Category.js" as Category
import "Format.js" as Format
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
  readonly property string icao: String(root.setting("icao", "")).toUpperCase().trim()
  readonly property int refreshMinutes: Math.max(1, parseInt(root.setting("refreshMinutes", 10), 10) || 10)
  // "auto" follows the aerodrome's country. "sera" or "faa" forces one.
  readonly property string ruleSetOverride: String(root.setting("rules", "auto")).toLowerCase()

  // ---------------------------------------------------------------- state

  property string rawMetar: ""
  property string rawTaf: ""
  property string errorText: ""
  property var station: null          // { country, site, elevationM }
  property int tick: 0                // bumped every minute, to re-age the display

  readonly property var report: rawMetar ? Metar.parse(rawMetar, { now: new Date() }) : null
  readonly property string country: station && station.country ? station.country : ""

  readonly property var category: {
    tick   // re-evaluate as the report ages past the staleness limit
    if (!report) return null
    Category.useCeilingInfo(Metar.ceilingInfo)
    return Category.categorize(report, {
      country: root.country,
      ruleSet: root.ruleSetOverride === "auto" ? "" : root.ruleSetOverride,
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

  readonly property var rows: report ? Format.rows(report, category, rowSlots) : []

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

  readonly property string apiBase: "https://aviationweather.gov/api/data"

  // The command is built here rather than bound to `icao`, because a binding
  // is evaluated lazily: setting `running = true` from onIcaoChanged could
  // start the process while `command` still held the previous code, and the
  // panel would then show the old aerodrome's name against the new weather.
  function refresh() {
    if (icao.length !== 4) {
      errorText = "Set an ICAO code"
      return
    }

    if (!weatherProc.running) {
      weatherProc.command = curl(apiBase + "/metar?ids=" + icao + "&format=raw&taf=true")
      weatherProc.running = true
    }

    if (!station && !stationProc.running) {
      stationProc.command = curl(apiBase + "/stationinfo?ids=" + icao + "&format=json")
      stationProc.running = true
    }
  }

  // NOAA blocks unidentified automated traffic, so the agent is never
  // optional. -fsS keeps curl silent on success and on an HTTP error alike.
  function curl(url) {
    return ["curl", "-fsS", "--max-time", "10", "-A", root.userAgent, url]
  }

  // One request returns both the METAR and the TAF.
  Process {
    id: weatherProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var text = String(this.text || "").trim()
        // curl -fsS prints nothing on an HTTP error, and an unknown ICAO
        // code returns 204 with an empty body rather than a 404.
        if (!text) {
          root.errorText = "No data for " + root.icao
          return
        }
        root.errorText = ""
        root.splitReports(text)
      }
    }
  }

  // The station's country decides the rule set, and its name fills the
  // header. Fetched once per ICAO code, then cached.
  Process {
    id: stationProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try {
          var rows = JSON.parse(String(this.text || "[]"))
          if (rows.length > 0) {
            root.station = {
              country: rows[0].country || "",
              site: rows[0].site || "",
              elevationM: rows[0].elev
            }
          }
        } catch (e) {
          root.station = null
        }
      }
    }
  }

  // The response is a METAR line, then the TAF, which wraps over several
  // lines. Everything from the TAF keyword onward belongs to the forecast.
  function splitReports(text) {
    var lines = text.split("\n")
    var metarLines = []
    var tafLines = []
    var inTaf = false

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (/^\s*TAF\b/.test(line)) inTaf = true
      if (inTaf) tafLines.push(line.replace(/\s+$/, ""))
      else if (line.trim()) metarLines.push(line.trim())
    }

    rawMetar = metarLines.join(" ").trim()
    rawTaf = tafLines.join("\n").trim()
  }

  onIcaoChanged: {
    station = null
    rawMetar = ""
    rawTaf = ""
    errorText = ""
    refresh()
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
                text: root.station && root.station.site ? root.station.site : ""
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

          // -------------------------------------------------- raw TAF
          //
          // Decoding and the hour-by-hour timeline come next; until then the
          // raw forecast is shown with one change group per line, which is
          // how a pilot reads it anyway.

          Column {
            width: parent.width
            spacing: Style.space(4)
            visible: root.rawTaf !== ""

            Text {
              text: "TAF"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1
            }

            Rectangle {
              width: parent.width
              radius: Style.cornerRadius > 0 ? Style.cornerRadius : Style.space(3)
              color: Util.alpha(root.foreground, 0.06)
              border.width: 1
              border.color: Util.alpha(root.foreground, 0.14)
              implicitHeight: tafText.implicitHeight + Style.space(16)

              Text {
                id: tafText
                anchors.fill: parent
                anchors.margins: Style.space(8)
                text: root.rawTaf
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
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
              text: root.category && root.category.source ? root.category.source : ""
              color: root.fainter
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
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
