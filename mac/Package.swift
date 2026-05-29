// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Specter",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Specter", targets: ["Specter"])
    ],
    dependencies: [
        // Auto-update framework. Pinned to a recent 2.x release.
        // Owner: see mac/sparkle/README.md for the one-time key-generation
        // step and the per-release sign_update step.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "Specter",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/Specter"
        )
    ]
)
