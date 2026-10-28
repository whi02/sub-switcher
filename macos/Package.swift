// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SubSwitcherBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "SubSwitcherBar",
            path: "Sources/SubSwitcherBar"
        )
    ]
)
