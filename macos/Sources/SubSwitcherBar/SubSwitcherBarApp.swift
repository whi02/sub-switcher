import SwiftUI

@main
struct SubSwitcherBarApp: App {
    // `@State` is a SwiftUI macro that Command Line Tools can't expand, so the store is a plain shared instance.
    private let store = UsageStore.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContentView()
                .environment(store)
        } label: {
            Image(systemName: "gauge.with.dots.needle.50percent")
            if let percent = store.menuBarPercent {
                Text("\(percent)%")
            }
        }
        .menuBarExtraStyle(.window)
    }
}
