import AppKit
import SwiftUI

/// One usage window of a subscription account, such as `7d` or `Fable`.
struct SubscriptionAccountUsageWindow: Decodable {
    let usageWindowName: String
    /// A fraction from 0 to 1.
    let utilization: Double
    /// ISO 8601, or null when the report gave no reset time.
    let resetsAt: String?
}

/// The fields of one subscription account in `GET /_proxy/api/subscription-account-status` that the menu bar shows.
struct SubscriptionAccountStatus: Decodable {
    let subscriptionAccountName: String
    let colour: String
    let emailAddress: String?
    let loginState: String
    let weeklyUtilization: Double?
    let isBlocked: Bool
    let blockedUntil: String?
    /// The window of the whole-account block, such as `five_hour` or `seven_day`.
    let blockedRateLimitWindow: String?
    let usageWindows: [SubscriptionAccountUsageWindow]
    /// The model windows for whose model the proxy avoids the account. Optional, because an older proxy omits it.
    let avoidedModelUsageWindowNames: [String]?
}

extension SubscriptionAccountStatus {
    /// The model window that the inner disc shows: an avoided one first, else the fullest one. Nil without a model window.
    var shownModelUsageWindow: SubscriptionAccountUsageWindow? {
        let avoidedNames = avoidedModelUsageWindowNames ?? []
        return usageWindows
            .filter { $0.usageWindowName != "5h" && $0.usageWindowName != "7d" }
            .max { first, second in
                let firstIsAvoided = avoidedNames.contains(first.usageWindowName)
                let secondIsAvoided = avoidedNames.contains(second.usageWindowName)
                if firstIsAvoided != secondIsAvoided { return secondIsAvoided }
                return first.utilization < second.utilization
            }
    }
}

struct SubscriptionAccountStatusResponse: Decodable {
    let subscriptionAccounts: [SubscriptionAccountStatus]
}

/// Reads the subscription account status from claude-proxy once a minute.
@MainActor
final class SubscriptionAccountStatusModel: ObservableObject {
    static let claudeProxyBaseUrl = URL(string: "http://127.0.0.1:4100")!
    static let refreshIntervalSeconds: TimeInterval = 60
    /// At login the app can start before the proxy listens, so a failed read is retried sooner than the normal refresh.
    static let retryAfterErrorSeconds: UInt64 = 5
    /// The relay writes this file and needs its credential with the user name `relay`. The local proxy has no such file.
    static let relayProxyCredentialUrl = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".claude-proxy-relay/proxy_credential")
    /// The relay does not serve the web UI. With this file, the web UI is on the central service.
    static let relayCentralUrlFileUrl = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: ".claude-proxy-relay/central_url")

    /// The web UI of the central service when this machine has a relay, or else of the local proxy.
    static func readWebUiUrl() -> URL {
        let centralUrlText = (try? String(contentsOf: relayCentralUrlFileUrl, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return (URL(string: centralUrlText) ?? claudeProxyBaseUrl).appending(path: "_proxy/")
    }

    @Published private(set) var subscriptionAccounts: [SubscriptionAccountStatus]?
    @Published private(set) var loadError: String?
    private let urlSession = URLSession(configuration: .ephemeral)
    private var refreshTimer: Timer?
    private var isRetryScheduled = false

    init() {
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: Self.refreshIntervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        Task {
            do {
                let statusUrl = Self.claudeProxyBaseUrl.appending(path: "_proxy/api/subscription-account-status")
                let (responseData, _) = try await urlSession.data(for: makeStatusRequest(statusUrl: statusUrl))
                subscriptionAccounts = try JSONDecoder().decode(SubscriptionAccountStatusResponse.self, from: responseData)
                    .subscriptionAccounts
                loadError = nil
            } catch {
                subscriptionAccounts = nil
                loadError = error.localizedDescription
                scheduleRetry()
            }
        }
    }

    /// Reads the relay's proxy credential at each poll, so a new relay works without a restart of the app.
    /// Without the file, the request has no `Authorization`, because the local proxy needs none.
    private func makeStatusRequest(statusUrl: URL) -> URLRequest {
        var statusRequest = URLRequest(url: statusUrl)
        if let relayProxyCredential = try? String(contentsOf: Self.relayProxyCredentialUrl, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines), !relayProxyCredential.isEmpty {
            let basicCredentials = Data("relay:\(relayProxyCredential)".utf8).base64EncodedString()
            statusRequest.setValue("Basic \(basicCredentials)", forHTTPHeaderField: "Authorization")
        }
        return statusRequest
    }

    private func scheduleRetry() {
        guard !isRetryScheduled else { return }
        isRetryScheduled = true
        Task {
            try? await Task.sleep(nanoseconds: Self.retryAfterErrorSeconds * 1_000_000_000)
            isRetryScheduled = false
            refresh()
        }
    }

    /// One weekly usage pie per subscription account, or a grey "!" dot when the proxy does not answer.
    var menuBarImage: NSImage {
        guard let subscriptionAccounts else {
            return makeProxyUnreachableImage()
        }
        return makeSubscriptionAccountPiesImage(subscriptionAccounts: subscriptionAccounts)
    }
}

let isoDateFormatters: [ISO8601DateFormatter] = [
    ISO8601DateFormatter(),
    {
        let fractionalSecondsFormatter = ISO8601DateFormatter()
        fractionalSecondsFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractionalSecondsFormatter
    }(),
]

func parseIsoDate(_ isoTimestamp: String) -> Date? {
    isoDateFormatters.lazy.compactMap { $0.date(from: isoTimestamp) }.first
}

/// Formats an ISO 8601 time as the local weekday and hour, for example "Tue 14:00".
func formatBlockedUntil(_ blockedUntil: String) -> String {
    guard let blockedUntilDate = parseIsoDate(blockedUntil) else {
        return blockedUntil
    }
    let localTimeFormatter = DateFormatter()
    localTimeFormatter.locale = Locale(identifier: "en_GB")
    localTimeFormatter.dateFormat = "EEE HH:mm"
    return localTimeFormatter.string(from: blockedUntilDate)
}

/// Formats the time until an ISO 8601 time in the form of the web UI: "3d 3h", "3h 5m" or "5m".
func formatTimeUntil(_ isoTimestamp: String, now: Date = Date()) -> String? {
    guard let date = parseIsoDate(isoTimestamp) else { return nil }
    let totalMinutes = max(0, Int(date.timeIntervalSince(now) / 60))
    let days = totalMinutes / 1440
    let hours = (totalMinutes % 1440) / 60
    let minutes = totalMinutes % 60
    if days > 0 { return "\(days)d \(hours)h" }
    if hours > 0 { return "\(hours)h \(minutes)m" }
    return "\(minutes)m"
}

/// The label of a usage window in the panel: "5-hour", "Weekly", or the model name, such as "Fable".
func labelUsageWindow(_ usageWindowName: String) -> String {
    switch usageWindowName {
    case "5h": return "5-hour"
    case "7d": return "Weekly"
    default: return usageWindowName
    }
}

/// Orders the windows 5h, 7d, then the model windows in the order received, as the web UI does.
func sortUsageWindows(_ usageWindows: [SubscriptionAccountUsageWindow]) -> [SubscriptionAccountUsageWindow] {
    let windowRank: (SubscriptionAccountUsageWindow) -> Int = { usageWindow in
        usageWindow.usageWindowName == "5h" ? 0 : usageWindow.usageWindowName == "7d" ? 1 : 2
    }
    return usageWindows.enumerated()
        .sorted { (windowRank($0.element), $0.offset) < (windowRank($1.element), $1.offset) }
        .map(\.element)
}

/// The reset text of each window, as "Resets in 3d 23h". A window with the same text as the window above it gets an
/// empty text, because the Fable window usually resets with the weekly window. A window without a reset time gets one too.
func describeUsageWindowResets(_ usageWindows: [SubscriptionAccountUsageWindow]) -> [String] {
    let resetTexts = usageWindows.map { usageWindow in
        usageWindow.resetsAt.flatMap { formatTimeUntil($0) }.map { "Resets in \($0)" } ?? ""
    }
    return resetTexts.indices.map { index in
        index > 0 && resetTexts[index] == resetTexts[index - 1] ? "" : resetTexts[index]
    }
}

/// The state of the whole account, or nil when the proxy uses it as normal.
func describeSubscriptionAccountBlock(_ subscriptionAccount: SubscriptionAccountStatus) -> String? {
    guard subscriptionAccount.isBlocked else { return nil }
    if let blockedUntil = subscriptionAccount.blockedUntil {
        return "Rejected, retried last until \(formatBlockedUntil(blockedUntil))"
    }
    return "Avoided, at the failover limit"
}

let blockedSubscriptionAccountColour = Color(nsColor: parseHexColour(blockedSubscriptionAccountColourHex) ?? .red)

/// A horizontal bar with a pale track and a fill for the fraction.
struct UsageBar: View {
    let fraction: Double
    let colour: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(colour.opacity(0.25))
                Capsule().fill(colour).frame(width: geometry.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 8)
    }
}

/// One account: a header with its colour, name and email address, a row per usage window, and its state lines.
struct SubscriptionAccountSection: View {
    let subscriptionAccount: SubscriptionAccountStatus

    var body: some View {
        let accountColour = Color(nsColor: parseHexColour(subscriptionAccount.colour) ?? .gray)
        let avoidedModelUsageWindowNames = subscriptionAccount.avoidedModelUsageWindowNames ?? []
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(accountColour).frame(width: 10, height: 10)
                Text(subscriptionAccount.subscriptionAccountName).font(.title3.bold())
                Spacer()
                if let emailAddress = subscriptionAccount.emailAddress {
                    Text(emailAddress).font(.callout).foregroundStyle(.secondary)
                }
            }
            if subscriptionAccount.loginState == "login_required" {
                Text("Log in from the web UI").font(.callout).foregroundStyle(blockedSubscriptionAccountColour)
            } else {
                let sortedUsageWindows = sortUsageWindows(subscriptionAccount.usageWindows)
                let resetTexts = describeUsageWindowResets(sortedUsageWindows)
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
                    ForEach(Array(sortedUsageWindows.enumerated()), id: \.element.usageWindowName) { windowIndex, usageWindow in
                        // The 5-hour and weekly bars are red when the proxy avoids the account, a model bar when it avoids the model.
                        let isAvoided = usageWindow.usageWindowName == "5h" || usageWindow.usageWindowName == "7d"
                            ? subscriptionAccount.isBlocked
                            : avoidedModelUsageWindowNames.contains(usageWindow.usageWindowName)
                        // The fixed widths of the text columns line up the bars of every account.
                        GridRow {
                            Text(labelUsageWindow(usageWindow.usageWindowName))
                                .frame(width: 60, alignment: .leading)
                            // The bar takes the width that the other columns leave.
                            UsageBar(fraction: usageWindow.utilization, colour: isAvoided ? blockedSubscriptionAccountColour : accountColour)
                                .frame(maxWidth: .infinity)
                            Text("\(Int((usageWindow.utilization * 100).rounded()))%")
                                .font(.body.monospacedDigit())
                                .frame(width: 44, alignment: .trailing)
                            Text(resetTexts[windowIndex])
                                .font(.body.monospacedDigit())
                                .frame(width: 140, alignment: .trailing)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
                if let accountBlock = describeSubscriptionAccountBlock(subscriptionAccount) {
                    Text(accountBlock).font(.callout).foregroundStyle(blockedSubscriptionAccountColour)
                }
                ForEach(avoidedModelUsageWindowNames, id: \.self) { modelUsageWindowName in
                    Text("Avoided for \(modelUsageWindowName) requests").font(.callout).foregroundStyle(blockedSubscriptionAccountColour)
                }
            }
        }
    }
}

/// The panel that opens from the menu bar: one section per account, then the actions.
struct SubscriptionAccountStatusPanel: View {
    @ObservedObject var subscriptionAccountStatusModel: SubscriptionAccountStatusModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let subscriptionAccounts = subscriptionAccountStatusModel.subscriptionAccounts {
                ForEach(subscriptionAccounts, id: \.subscriptionAccountName) { subscriptionAccount in
                    SubscriptionAccountSection(subscriptionAccount: subscriptionAccount)
                    Divider()
                }
            } else {
                Text("claude-proxy does not answer on port 4100").font(.headline)
                if let loadError = subscriptionAccountStatusModel.loadError {
                    Text(loadError).font(.caption).foregroundStyle(.secondary)
                }
                Divider()
            }
            HStack {
                Button("Open web UI") {
                    NSWorkspace.shared.open(SubscriptionAccountStatusModel.readWebUiUrl())
                }
                Spacer()
                Button("Refresh") {
                    subscriptionAccountStatusModel.refresh()
                }
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }
        }
        .padding(12)
        .frame(width: 420)
    }
}

@main
struct ClaudeProxyMenuBarApplication: App {
    @StateObject private var subscriptionAccountStatusModel = SubscriptionAccountStatusModel()

    var body: some Scene {
        MenuBarExtra {
            SubscriptionAccountStatusPanel(subscriptionAccountStatusModel: subscriptionAccountStatusModel)
        } label: {
            Image(nsImage: subscriptionAccountStatusModel.menuBarImage)
        }
        .menuBarExtraStyle(.window)
    }
}

let blockedSubscriptionAccountColourHex = "#e5484d"
let subscriptionAccountPieDiameter: CGFloat = 16
let subscriptionAccountPieSpacing: CGFloat = 4
let menuBarImageHeight: CGFloat = 18

/// Draws one pie per subscription account. The image is not a template image, so macOS keeps its colours.
func makeSubscriptionAccountPiesImage(subscriptionAccounts: [SubscriptionAccountStatus]) -> NSImage {
    let pieCount = CGFloat(subscriptionAccounts.count)
    let pieMargin = (menuBarImageHeight - subscriptionAccountPieDiameter) / 2
    let imageWidth = max(
        pieMargin * 2 + pieCount * subscriptionAccountPieDiameter + max(pieCount - 1, 0) * subscriptionAccountPieSpacing,
        menuBarImageHeight
    )
    let piesImage = NSImage(size: NSSize(width: imageWidth, height: menuBarImageHeight), flipped: false) { _ in
        for (pieIndex, subscriptionAccount) in subscriptionAccounts.enumerated() {
            let pieRect = NSRect(
                x: pieMargin + CGFloat(pieIndex) * (subscriptionAccountPieDiameter + subscriptionAccountPieSpacing),
                y: pieMargin,
                width: subscriptionAccountPieDiameter,
                height: subscriptionAccountPieDiameter
            )
            drawSubscriptionAccountPie(subscriptionAccount: subscriptionAccount, in: pieRect)
        }
        return true
    }
    piesImage.isTemplate = false
    return piesImage
}

/// The hole in the weekly pie leaves a ring of 3 points. The model disc sits in the hole with a gap of 1 point.
let modelUsageHoleDiameter: CGFloat = 10
let modelUsageDiscDiameter: CGFloat = 8

/// Draws the weekly window as the outer pie, or ring, and the model window, such as Fable, as the inner disc.
/// Each part turns red on its own: the ring when the proxy avoids the account, the disc when it avoids the model.
func drawSubscriptionAccountPie(subscriptionAccount: SubscriptionAccountStatus, in pieRect: NSRect) {
    if subscriptionAccount.loginState == "login_required" {
        drawUsagePie(fraction: 0, colour: .gray, in: pieRect)
        return
    }

    let accountColour = parseHexColour(subscriptionAccount.colour) ?? .gray
    let blockedColour = parseHexColour(blockedSubscriptionAccountColourHex) ?? .red

    // A block for a weekly window draws a full pie, because the stored weekly utilization can be below 1.
    let isBlockedForWeeklyWindow = subscriptionAccount.blockedRateLimitWindow?.hasPrefix("seven_day") ?? false
    let weeklyFraction = isBlockedForWeeklyWindow ? 1 : subscriptionAccount.weeklyUtilization ?? 0
    drawUsagePie(fraction: weeklyFraction, colour: subscriptionAccount.isBlocked ? blockedColour : accountColour, in: pieRect)

    guard let modelUsageWindow = subscriptionAccount.shownModelUsageWindow else { return }
    let holeRect = centredSquare(in: pieRect, diameter: modelUsageHoleDiameter)
    NSGraphicsContext.current?.compositingOperation = .clear
    NSBezierPath(ovalIn: holeRect).fill()
    NSGraphicsContext.current?.compositingOperation = .sourceOver

    // A model that the proxy avoids draws a full disc, because a rejection can come below the stored utilization.
    let isModelAvoided = (subscriptionAccount.avoidedModelUsageWindowNames ?? []).contains(modelUsageWindow.usageWindowName)
    drawUsagePie(
        fraction: isModelAvoided ? 1 : modelUsageWindow.utilization,
        colour: isModelAvoided ? blockedColour : accountColour,
        in: centredSquare(in: pieRect, diameter: modelUsageDiscDiameter)
    )
}

func centredSquare(in rect: NSRect, diameter: CGFloat) -> NSRect {
    NSRect(x: rect.midX - diameter / 2, y: rect.midY - diameter / 2, width: diameter, height: diameter)
}

/// Draws a pie with a pale track, a wedge clockwise from the top for the fraction, and a dark outline.
func drawUsagePie(fraction: Double, colour: NSColor, in pieRect: NSRect) {
    let outlinePath = NSBezierPath(ovalIn: pieRect.insetBy(dx: 0.5, dy: 0.5))
    colour.withAlphaComponent(0.25).setFill()
    outlinePath.fill()

    let clampedFraction = min(max(fraction, 0), 1)
    if clampedFraction >= 1 {
        colour.setFill()
        outlinePath.fill()
    } else if clampedFraction > 0 {
        let wedgePath = NSBezierPath()
        let pieCentre = NSPoint(x: pieRect.midX, y: pieRect.midY)
        wedgePath.move(to: pieCentre)
        wedgePath.appendArc(
            withCenter: pieCentre,
            radius: pieRect.width / 2 - 0.5,
            startAngle: 90,
            endAngle: 90 - 360 * clampedFraction,
            clockwise: true
        )
        wedgePath.close()
        colour.setFill()
        wedgePath.fill()
    }

    NSColor.black.withAlphaComponent(0.6).setStroke()
    outlinePath.lineWidth = 1
    outlinePath.stroke()
}

/// Draws a grey dot with an exclamation mark, for when the proxy does not answer.
func makeProxyUnreachableImage() -> NSImage {
    let fillColour = parseHexColour("#9aa3ae") ?? .gray
    let letterColour = relativeLuminance(of: fillColour) > 0.4 ? NSColor.black : NSColor.white
    let unreachableImage = NSImage(size: NSSize(width: menuBarImageHeight, height: menuBarImageHeight), flipped: false) { imageRect in
        let circlePath = NSBezierPath(ovalIn: imageRect.insetBy(dx: 1, dy: 1))
        fillColour.setFill()
        circlePath.fill()
        NSColor.black.withAlphaComponent(0.35).setStroke()
        circlePath.lineWidth = 1
        circlePath.stroke()

        let letterAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .bold),
            .foregroundColor: letterColour,
        ]
        let letterText = "!" as NSString
        let letterSize = letterText.size(withAttributes: letterAttributes)
        letterText.draw(
            at: NSPoint(x: (imageRect.width - letterSize.width) / 2, y: (imageRect.height - letterSize.height) / 2),
            withAttributes: letterAttributes
        )
        return true
    }
    unreachableImage.isTemplate = false
    return unreachableImage
}

func parseHexColour(_ colourHex: String) -> NSColor? {
    let hexDigits = colourHex.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
    guard hexDigits.count == 6, let colourValue = UInt32(hexDigits, radix: 16) else { return nil }
    return NSColor(
        srgbRed: CGFloat((colourValue >> 16) & 0xff) / 255,
        green: CGFloat((colourValue >> 8) & 0xff) / 255,
        blue: CGFloat(colourValue & 0xff) / 255,
        alpha: 1
    )
}

func relativeLuminance(of colour: NSColor) -> CGFloat {
    guard let srgbColour = colour.usingColorSpace(.sRGB) else { return 0.5 }
    let linearise = { (channelValue: CGFloat) -> CGFloat in
        channelValue <= 0.03928 ? channelValue / 12.92 : pow((channelValue + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linearise(srgbColour.redComponent) + 0.7152 * linearise(srgbColour.greenComponent)
        + 0.0722 * linearise(srgbColour.blueComponent)
}
