import AppKit
import SwiftUI

/// The fields of `GET /_proxy/api/routing-status` that the menu bar shows.
struct RoutingStatus: Decodable {
    struct RouteAppearance: Decodable {
        let routeKind: String
        let routeName: String
        let letter: String
        let colour: String
    }

    let routingMode: String
    let activeRoute: RouteAppearance
    let subscriptionWeeklyUtilization: Double?
    let subscriptionWeeklyLimitReached: Bool
}

/// Reads the routing status from claude-proxy once a minute.
@MainActor
final class RoutingStatusModel: ObservableObject {
    static let claudeProxyBaseUrl = URL(string: "http://127.0.0.1:4100")!
    static let refreshIntervalSeconds: TimeInterval = 60
    /// At login the app can start before the proxy listens, so a failed read is retried sooner than the normal refresh.
    static let retryAfterErrorSeconds: UInt64 = 5

    @Published private(set) var routingStatus: RoutingStatus?
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
                let routingStatusUrl = Self.claudeProxyBaseUrl.appending(path: "_proxy/api/routing-status")
                let (responseData, _) = try await urlSession.data(from: routingStatusUrl)
                routingStatus = try JSONDecoder().decode(RoutingStatus.self, from: responseData)
                loadError = nil
            } catch {
                routingStatus = nil
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

    /// The dot in the menu bar: the active route's letter on its colour, or a grey "!" when the proxy does not answer.
    var menuBarImage: NSImage {
        guard let activeRoute = routingStatus?.activeRoute else {
            return makeRouteDotImage(letter: "!", colourHex: "#9aa3ae")
        }
        return makeRouteDotImage(letter: activeRoute.letter, colourHex: activeRoute.colour)
    }
}

let routingModeDescriptions = [
    "auto": "Auto",
    "force_subscription": "Subscription only",
    "force_api_key": "API key only",
]

struct RoutingStatusMenu: View {
    @ObservedObject var routingStatusModel: RoutingStatusModel

    var body: some View {
        if let routingStatus = routingStatusModel.routingStatus {
            Text("Route: \(routingStatus.activeRoute.routeKind == "subscription" ? "Subscription" : routingStatus.activeRoute.routeName)")
            Text("Mode: \(routingModeDescriptions[routingStatus.routingMode] ?? routingStatus.routingMode)")
            if let weeklyUtilization = routingStatus.subscriptionWeeklyUtilization {
                Text("Weekly subscription usage: \(Int((weeklyUtilization * 100).rounded()))%")
            }
            if routingStatus.subscriptionWeeklyLimitReached {
                Text("Weekly subscription limit reached")
            }
        } else {
            Text("claude-proxy does not answer on port 4100")
            if let loadError = routingStatusModel.loadError {
                Text(loadError)
            }
        }
        Divider()
        Button("Open web UI") {
            NSWorkspace.shared.open(RoutingStatusModel.claudeProxyBaseUrl.appending(path: "_proxy/"))
        }
        Button("Refresh now") {
            routingStatusModel.refresh()
        }
        Divider()
        Button("Quit") {
            NSApplication.shared.terminate(nil)
        }
    }
}

@main
struct ClaudeProxyMenuBarApplication: App {
    @StateObject private var routingStatusModel = RoutingStatusModel()

    var body: some Scene {
        MenuBarExtra {
            RoutingStatusMenu(routingStatusModel: routingStatusModel)
        } label: {
            Image(nsImage: routingStatusModel.menuBarImage)
        }
    }
}

/// Draws a filled circle with a letter on it. The image is not a template image, so macOS keeps its colours.
func makeRouteDotImage(letter: String, colourHex: String) -> NSImage {
    let fillColour = parseHexColour(colourHex) ?? .gray
    let letterColour = relativeLuminance(of: fillColour) > 0.4 ? NSColor.black : NSColor.white
    let routeDotImage = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { imageRect in
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
        let letterText = letter as NSString
        let letterSize = letterText.size(withAttributes: letterAttributes)
        letterText.draw(
            at: NSPoint(x: (imageRect.width - letterSize.width) / 2, y: (imageRect.height - letterSize.height) / 2),
            withAttributes: letterAttributes
        )
        return true
    }
    routeDotImage.isTemplate = false
    return routeDotImage
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
