import AppKit
import SwiftUI

/// The fields of one subscription account in `GET /_proxy/api/subscription-account-status` that the menu bar shows.
struct SubscriptionAccountStatus: Decodable {
    let subscriptionAccountName: String
    let colour: String
    let loginState: String
    let weeklyUtilization: Double?
    let isBlocked: Bool
    let blockedUntil: String?
    /// The window of the whole-account block, such as `five_hour` or `seven_day`.
    let blockedRateLimitWindow: String?
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
                let (responseData, _) = try await urlSession.data(from: statusUrl)
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

let blockedUntilIsoFormatters: [ISO8601DateFormatter] = [
    ISO8601DateFormatter(),
    {
        let fractionalSecondsFormatter = ISO8601DateFormatter()
        fractionalSecondsFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractionalSecondsFormatter
    }(),
]

/// Formats an ISO 8601 time as the local weekday and hour, for example "Tue 14:00".
func formatBlockedUntil(_ blockedUntil: String) -> String {
    guard let blockedUntilDate = blockedUntilIsoFormatters.lazy.compactMap({ $0.date(from: blockedUntil) }).first else {
        return blockedUntil
    }
    let localTimeFormatter = DateFormatter()
    localTimeFormatter.locale = Locale(identifier: "en_GB")
    localTimeFormatter.dateFormat = "EEE HH:mm"
    return localTimeFormatter.string(from: blockedUntilDate)
}

func describeSubscriptionAccount(_ subscriptionAccount: SubscriptionAccountStatus) -> String {
    let name = subscriptionAccount.subscriptionAccountName
    if subscriptionAccount.loginState == "login_required" {
        return "\(name): log in from the web UI"
    }
    if subscriptionAccount.isBlocked {
        if let blockedUntil = subscriptionAccount.blockedUntil {
            return "\(name): rejected, retried last until \(formatBlockedUntil(blockedUntil))"
        }
        return "\(name): avoided, at the failover limit"
    }
    if let weeklyUtilization = subscriptionAccount.weeklyUtilization {
        return "\(name): \(Int((weeklyUtilization * 100).rounded()))% weekly"
    }
    return "\(name): no weekly usage known"
}

struct SubscriptionAccountStatusMenu: View {
    @ObservedObject var subscriptionAccountStatusModel: SubscriptionAccountStatusModel

    var body: some View {
        if let subscriptionAccounts = subscriptionAccountStatusModel.subscriptionAccounts {
            ForEach(subscriptionAccounts, id: \.subscriptionAccountName) { subscriptionAccount in
                Text(describeSubscriptionAccount(subscriptionAccount))
            }
        } else {
            Text("claude-proxy does not answer on port 4100")
            if let loadError = subscriptionAccountStatusModel.loadError {
                Text(loadError)
            }
        }
        Divider()
        Button("Open web UI") {
            NSWorkspace.shared.open(SubscriptionAccountStatusModel.claudeProxyBaseUrl.appending(path: "_proxy/"))
        }
        Button("Refresh now") {
            subscriptionAccountStatusModel.refresh()
        }
        Divider()
        Button("Quit") {
            NSApplication.shared.terminate(nil)
        }
    }
}

@main
struct ClaudeProxyMenuBarApplication: App {
    @StateObject private var subscriptionAccountStatusModel = SubscriptionAccountStatusModel()

    var body: some Scene {
        MenuBarExtra {
            SubscriptionAccountStatusMenu(subscriptionAccountStatusModel: subscriptionAccountStatusModel)
        } label: {
            Image(nsImage: subscriptionAccountStatusModel.menuBarImage)
        }
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

func drawSubscriptionAccountPie(subscriptionAccount: SubscriptionAccountStatus, in pieRect: NSRect) {
    let outlinePath = NSBezierPath(ovalIn: pieRect.insetBy(dx: 0.5, dy: 0.5))
    let outlineColour = NSColor.black.withAlphaComponent(0.6)

    if subscriptionAccount.loginState == "login_required" {
        NSColor.gray.withAlphaComponent(0.25).setFill()
        outlinePath.fill()
        outlineColour.setStroke()
        outlinePath.lineWidth = 1
        outlinePath.stroke()
        return
    }

    let pieColourHex = subscriptionAccount.isBlocked ? blockedSubscriptionAccountColourHex : subscriptionAccount.colour
    let pieColour = parseHexColour(pieColourHex) ?? .gray
    pieColour.withAlphaComponent(0.25).setFill()
    outlinePath.fill()

    // A block for a weekly window draws a full pie, because the stored weekly utilization can be below 1.
    let isBlockedForWeeklyWindow = subscriptionAccount.blockedRateLimitWindow?.hasPrefix("seven_day") ?? false
    let weeklyFraction = isBlockedForWeeklyWindow ? 1 : min(max(subscriptionAccount.weeklyUtilization ?? 0, 0), 1)
    if weeklyFraction >= 1 {
        pieColour.setFill()
        outlinePath.fill()
    } else if weeklyFraction > 0 {
        let wedgePath = NSBezierPath()
        let pieCentre = NSPoint(x: pieRect.midX, y: pieRect.midY)
        wedgePath.move(to: pieCentre)
        wedgePath.appendArc(
            withCenter: pieCentre,
            radius: pieRect.width / 2 - 0.5,
            startAngle: 90,
            endAngle: 90 - 360 * weeklyFraction,
            clockwise: true
        )
        wedgePath.close()
        pieColour.setFill()
        wedgePath.fill()
    }

    outlineColour.setStroke()
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
