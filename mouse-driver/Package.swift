// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ghost-mouse-driver",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "ghost-mouse-driver",
            path: "Sources"
        )
    ]
)
