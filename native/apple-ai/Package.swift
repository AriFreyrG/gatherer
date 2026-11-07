// swift-tools-version: 6.2
// Small command-line helper that lets Gatherer use Apple's on-device model (Apple Intelligence,
// Foundation Models framework). Build with `npm run build:apple-ai` from the repository root.
import PackageDescription

let package = Package(
    name: "gatherer-ai",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "gatherer-ai", path: "Sources/gatherer-ai")
    ]
)
