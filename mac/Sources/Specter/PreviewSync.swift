import AppKit
import Foundation
import SwiftUI

// MARK: - SyncPlan models (shape mirrors src/types.ts SyncPlan / PlanEntry)

struct SyncPlan: Decodable {
    let direction: String
    let creates: [PlanEntry]
    let updates: [PlanEntry]
    let metadataUpdates: [PlanEntry]
    let deletes: [PlanEntry]
    let conflicts: [PlanEntry]
    let skips: [PlanEntry]
    let errors: [PlanEntry]
}

struct PlanEntry: Decodable, Identifiable {
    /// JSON has no id — synthesize one for SwiftUI's Identifiable. The combination
    /// of side+title+path is unique within a category, which is all the list needs.
    var id: String { "\(side)|\(title)|\(localPath ?? "")|\(ghostId ?? "")" }
    let side: String
    let title: String
    let ghostId: String?
    let localPath: String?
    let details: String?
}

// MARK: - Controller

@MainActor
final class PreviewController: ObservableObject {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded(SyncPlan)
        case failed(String)

        static func == (lhs: LoadState, rhs: LoadState) -> Bool {
            switch (lhs, rhs) {
            case (.idle, .idle), (.loading, .loading): return true
            case (.loaded, .loaded): return true
            case let (.failed(a), .failed(b)): return a == b
            default: return false
            }
        }
    }

    @Published var state: LoadState = .idle
    @Published var targetHandle: String?

    func configure(targetHandle: String?) {
        self.targetHandle = targetHandle
        state = .idle
    }

    /// Run the dry-run subprocess and decode the JSON plan.
    func refresh() {
        guard let node = Paths.nodeBinary(), let entry = Paths.daemonEntry() else {
            state = .failed("Bundled daemon not found.")
            return
        }
        let targetHandle = targetHandle
        state = .loading
        DispatchQueue.global().async {
            let task = Process()
            task.executableURL = node
            var arguments = [entry.path, "sync"]
            if let targetHandle, !targetHandle.isEmpty {
                arguments.append("--target")
                arguments.append(targetHandle)
            }
            arguments.append("--dry-run")
            arguments.append("--json")
            task.arguments = arguments
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
            task.environment = env
            let out = Pipe()
            let err = Pipe()
            task.standardOutput = out
            task.standardError = err

            var result: LoadState
            do {
                try task.run()
                task.waitUntilExit()
                let data = out.fileHandleForReading.readDataToEndOfFile()
                if task.terminationStatus != 0 {
                    let errData = err.fileHandleForReading.readDataToEndOfFile()
                    let msg = String(data: errData, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    result = .failed(msg?.isEmpty == false ? msg! : "Dry-run exited with code \(task.terminationStatus)")
                } else if let plan = try? JSONDecoder().decode(SyncPlan.self, from: data) {
                    result = .loaded(plan)
                } else {
                    result = .failed("Couldn't parse dry-run output.")
                }
            } catch {
                result = .failed(error.localizedDescription)
            }
            DispatchQueue.main.async {
                self.state = result
            }
        }
    }
}

// MARK: - View

struct PreviewSyncView: View {
    @ObservedObject var controller: PreviewController
    @ObservedObject var store: StatusStore
    var onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            footer
        }
        .frame(width: 620, height: 520)
        .onAppear {
            if case .idle = controller.state { controller.refresh() }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(controller.targetHandle.map { "Preview Sync — \($0)" } ?? "Preview Sync")
                    .font(.title2)
                    .bold()
                Text("What would change if you synced right now. Nothing is touched until you press Run Sync Now.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                controller.refresh()
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(controller.state == .loading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var content: some View {
        switch controller.state {
        case .idle, .loading:
            VStack(spacing: 12) {
                ProgressView()
                Text("Computing plan…").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed(let msg):
            VStack(alignment: .leading, spacing: 8) {
                Label("Couldn't compute plan", systemImage: "exclamationmark.octagon")
                    .foregroundStyle(.red)
                    .font(.headline)
                ScrollView { Text(msg).font(.callout).foregroundStyle(.secondary) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)

        case .loaded(let plan):
            PlanList(plan: plan)
        }
    }

    private var footer: some View {
        HStack {
            if case .loaded(let plan) = controller.state {
                Text(summary(plan))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Close", action: onClose)
            Button {
                onClose()
                if let handle = controller.targetHandle, !handle.isEmpty {
                    MenuActions.runForTarget("sync", targetHandle: handle, store: store)
                } else {
                    MenuActions.run("sync", store: store)
                }
            } label: {
                Label("Run Sync Now", systemImage: "arrow.triangle.2.circlepath")
            }
            .keyboardShortcut(.defaultAction)
            .disabled({
                if case .loaded(let plan) = controller.state {
                    return plan.creates.isEmpty
                        && plan.updates.isEmpty
                        && plan.deletes.isEmpty
                        && plan.conflicts.isEmpty
                }
                return true
            }())
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func summary(_ plan: SyncPlan) -> String {
        var parts: [String] = []
        if !plan.creates.isEmpty { parts.append("\(plan.creates.count) create") }
        if !plan.updates.isEmpty { parts.append("\(plan.updates.count) update") }
        if !plan.metadataUpdates.isEmpty { parts.append("\(plan.metadataUpdates.count) metadata") }
        if !plan.deletes.isEmpty { parts.append("\(plan.deletes.count) delete") }
        if !plan.conflicts.isEmpty { parts.append("\(plan.conflicts.count) conflict") }
        if !plan.errors.isEmpty { parts.append("\(plan.errors.count) error") }
        if parts.isEmpty {
            return plan.skips.isEmpty ? "Nothing planned." : "\(plan.skips.count) skip — already in sync."
        }
        return parts.joined(separator: ", ") + (plan.skips.isEmpty ? "" : " (\(plan.skips.count) skip)")
    }
}

private struct PlanList: View {
    let plan: SyncPlan

    var body: some View {
        if isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "checkmark.seal.fill").font(.largeTitle).foregroundStyle(.green)
                Text("Everything is in sync").font(.headline)
                Text("No creates, updates, or conflicts pending.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List {
                section(title: "Conflicts", systemImage: "exclamationmark.triangle.fill",
                        tint: .orange, entries: plan.conflicts)
                section(title: "Creates", systemImage: "plus.circle.fill",
                        tint: .green, entries: plan.creates)
                section(title: "Updates", systemImage: "arrow.up.arrow.down.circle.fill",
                        tint: .blue, entries: plan.updates)
                section(title: "Metadata", systemImage: "tag.circle.fill",
                        tint: .purple, entries: plan.metadataUpdates)
                section(title: "Deletes", systemImage: "minus.circle.fill",
                        tint: .red, entries: plan.deletes)
                section(title: "Errors", systemImage: "xmark.octagon.fill",
                        tint: .red, entries: plan.errors)
            }
            .listStyle(.inset)
        }
    }

    private var isEmpty: Bool {
        plan.creates.isEmpty && plan.updates.isEmpty
            && plan.metadataUpdates.isEmpty && plan.deletes.isEmpty
            && plan.conflicts.isEmpty && plan.errors.isEmpty
    }

    @ViewBuilder
    private func section(title: String, systemImage: String, tint: Color, entries: [PlanEntry]) -> some View {
        if !entries.isEmpty {
            Section {
                ForEach(entries) { entry in
                    PlanRow(entry: entry)
                }
            } header: {
                Label("\(title) (\(entries.count))", systemImage: systemImage)
                    .foregroundStyle(tint)
            }
        }
    }
}

private struct PlanRow: View {
    let entry: PlanEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(entry.title.isEmpty ? "(untitled)" : entry.title)
                    .font(.body)
                    .lineLimit(1)
                Spacer()
                Text(entry.side == "remote" ? "Ghost" : "Local")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(entry.side == "remote" ? Color.purple.opacity(0.15) : Color.blue.opacity(0.15))
                    .cornerRadius(4)
            }
            if let detail = entry.details {
                Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            if let path = entry.localPath {
                Text(path).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            } else if let gid = entry.ghostId {
                Text("Ghost id: \(gid)").font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}
