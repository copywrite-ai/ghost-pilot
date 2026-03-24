import Foundation
import CoreGraphics

// MARK: - Data Models

struct MouseEvent: Codable {
    let t: UInt64       // milliseconds since recording start
    let x: Double
    let y: Double
    let type: String    // "move", "down", "up", "drag"
}

struct Recording: Codable {
    let recordedAt: String
    let screen: ScreenInfo
    let durationMs: UInt64
    let eventCount: Int
    let events: [MouseEvent]
}

struct ScreenInfo: Codable {
    let width: Int
    let height: Int
}

// MARK: - Easing

func easeOutCubic(_ t: Double) -> Double {
    let t1 = t - 1.0
    return t1 * t1 * t1 + 1.0
}

func easeInOutCubic(_ t: Double) -> Double {
    if t < 0.5 {
        return 4 * t * t * t
    } else {
        let f = 2 * t - 2
        return 0.5 * f * f * f + 1
    }
}

// MARK: - Mouse Actions

func getCurrentMouseLocation() -> CGPoint {
    return CGEvent(source: nil)?.location ?? CGPoint.zero
}

func smoothMove(to target: CGPoint, durationMs: Int = 800, steps: Int = 60) {
    let start = getCurrentMouseLocation()
    let stepDelay = Double(durationMs) / Double(steps) / 1000.0 // seconds

    for i in 1...steps {
        let progress = easeInOutCubic(Double(i) / Double(steps))
        let x = start.x + (target.x - start.x) * progress
        let y = start.y + (target.y - start.y) * progress
        let point = CGPoint(x: x, y: y)

        if let event = CGEvent(mouseEventSource: nil,
                               mouseType: .mouseMoved,
                               mouseCursorPosition: point,
                               mouseButton: .left) {
            event.post(tap: .cghidEventTap)
        }

        Thread.sleep(forTimeInterval: stepDelay)
    }
}

func click(at point: CGPoint) {
    if let down = CGEvent(mouseEventSource: nil,
                          mouseType: .leftMouseDown,
                          mouseCursorPosition: point,
                          mouseButton: .left) {
        down.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.05) // 50ms hold
    if let up = CGEvent(mouseEventSource: nil,
                        mouseType: .leftMouseUp,
                        mouseCursorPosition: point,
                        mouseButton: .left) {
        up.post(tap: .cghidEventTap)
    }
}

func scrollAt(point: CGPoint, deltaY: Int32) {
    // Move to position first
    if let moveEvent = CGEvent(mouseEventSource: nil,
                               mouseType: .mouseMoved,
                               mouseCursorPosition: point,
                               mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.05)

    if let scrollEvent = CGEvent(scrollWheelEvent2Source: nil,
                                  units: .line,
                                  wheelCount: 1,
                                  wheel1: deltaY,
                                  wheel2: 0,
                                  wheel3: 0) {
        scrollEvent.post(tap: .cghidEventTap)
    }
}

/// Smooth pixel-based scroll that mimics trackpad gesture.
/// totalPixels: total pixels to scroll (negative = down, positive = up)
/// durationMs: duration of the scroll gesture
/// steps: number of scroll events to emit
func smoothScroll(at point: CGPoint, totalPixels: Int, durationMs: Int = 600, steps: Int = 30) {
    // Move to position first
    if let moveEvent = CGEvent(mouseEventSource: nil,
                               mouseType: .mouseMoved,
                               mouseCursorPosition: point,
                               mouseButton: .left) {
        moveEvent.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.05)

    let stepDelay = Double(durationMs) / Double(steps) / 1000.0

    // Distribute pixels across steps with ease-out curve
    for i in 1...steps {
        let prevProgress = easeOutCubic(Double(i - 1) / Double(steps))
        let currProgress = easeOutCubic(Double(i) / Double(steps))
        let stepPixels = Int32(round(Double(totalPixels) * (currProgress - prevProgress)))

        if stepPixels == 0 { continue }

        if let scrollEvent = CGEvent(scrollWheelEvent2Source: nil,
                                      units: .pixel,
                                      wheelCount: 1,
                                      wheel1: stepPixels,
                                      wheel2: 0,
                                      wheel3: 0) {
            scrollEvent.post(tap: .cghidEventTap)
        }

        Thread.sleep(forTimeInterval: stepDelay)
    }
}

func typeText(_ text: String, delayMs: Int = 50) {
    for char in text {
        let str = String(char)
        if let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
            var chars = Array(str.utf16)
            keyDown.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
            keyDown.post(tap: .cghidEventTap)
        }
        if let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
            keyUp.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: Double(delayMs) / 1000.0)
    }
}

// MARK: - Recorder (from mouse-recorder)

class MouseRecorder {
    private var events: [MouseEvent] = []
    private var startTime: UInt64 = 0
    private var isRecording = false
    private var eventTap: CFMachPort?

    func start() {
        events.removeAll()
        startTime = mach_absolute_time()
        isRecording = true

        let eventMask: CGEventMask = (
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.leftMouseDragged.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDragged.rawValue)
        )

        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: eventMask,
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                guard let refcon = refcon else {
                    return Unmanaged.passRetained(event)
                }
                let recorder = Unmanaged<MouseRecorder>.fromOpaque(refcon).takeUnretainedValue()
                recorder.handleEvent(type: type, event: event)
                return Unmanaged.passRetained(event)
            },
            userInfo: selfPtr
        ) else {
            fputs("❌ Failed to create event tap.\n", stderr)
            fputs("   → Go to System Settings → Privacy & Security → Accessibility\n", stderr)
            fputs("   → Add Terminal (or your terminal app) to the allowed list.\n", stderr)
            exit(1)
        }

        self.eventTap = tap
        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)

        fputs("🔴 Recording mouse events... Press Ctrl+C to stop.\n", stderr)
    }

    func handleEvent(type: CGEventType, event: CGEvent) {
        guard isRecording else { return }

        let location = event.location
        let elapsed = machToMs(mach_absolute_time() - startTime)

        let typeName: String
        switch type {
        case .mouseMoved:       typeName = "move"
        case .leftMouseDown:    typeName = "down"
        case .leftMouseUp:      typeName = "up"
        case .leftMouseDragged: typeName = "drag"
        case .rightMouseDown:   typeName = "rdown"
        case .rightMouseUp:     typeName = "rup"
        case .rightMouseDragged: typeName = "rdrag"
        default:                typeName = "other"
        }

        let evt = MouseEvent(
            t: elapsed,
            x: round(location.x * 10) / 10,
            y: round(location.y * 10) / 10,
            type: typeName
        )
        events.append(evt)
    }

    func stop() -> Recording {
        isRecording = false
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }

        let elapsed = machToMs(mach_absolute_time() - startTime)
        let mainDisplay = CGMainDisplayID()
        let screenWidth = CGDisplayPixelsWide(mainDisplay)
        let screenHeight = CGDisplayPixelsHigh(mainDisplay)

        return Recording(
            recordedAt: ISO8601DateFormatter().string(from: Date()),
            screen: ScreenInfo(width: screenWidth, height: screenHeight),
            durationMs: elapsed,
            eventCount: events.count,
            events: events
        )
    }

    private func machToMs(_ machDelta: UInt64) -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let nanos = machDelta * UInt64(info.numer) / UInt64(info.denom)
        return nanos / 1_000_000
    }
}

// MARK: - Replayer (from mouse-recorder)

class MouseReplayer {
    func replay(recording: Recording, speedMultiplier: Double = 1.0) {
        let events = recording.events
        guard !events.isEmpty else {
            fputs("⚠️  No events to replay.\n", stderr)
            return
        }

        fputs("▶️  Replaying \(events.count) events (\(recording.durationMs)ms) at \(speedMultiplier)x speed...\n", stderr)

        let startTime = mach_absolute_time()
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)

        for (i, evt) in events.enumerated() {
            let targetNanos = Double(evt.t) * 1_000_000.0 / speedMultiplier
            let targetMach = UInt64(targetNanos) * UInt64(info.denom) / UInt64(info.numer)

            while (mach_absolute_time() - startTime) < targetMach { }

            let point = CGPoint(x: evt.x, y: evt.y)

            switch evt.type {
            case "move":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) { e.post(tap: .cghidEventTap) }
            case "down":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) { e.post(tap: .cghidEventTap) }
            case "up":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) { e.post(tap: .cghidEventTap) }
            case "drag":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) { e.post(tap: .cghidEventTap) }
            case "rdown":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) { e.post(tap: .cghidEventTap) }
            case "rup":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) { e.post(tap: .cghidEventTap) }
            case "rdrag":
                if let e = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDragged, mouseCursorPosition: point, mouseButton: .right) { e.post(tap: .cghidEventTap) }
            default: break
            }

            if i > 0 && i % 500 == 0 {
                let pct = Int(Double(i) / Double(events.count) * 100)
                fputs("\r   \(pct)% (\(i)/\(events.count) events)", stderr)
            }
        }

        fputs("\r✅ Replay complete — \(events.count) events replayed.\n", stderr)
    }
}

// MARK: - CLI

func printUsage() {
    let usage = """
    ghost-mouse-driver — Real OS-level mouse automation for ghost-pilot

    USAGE:
      ghost-mouse-driver move-click --x X --y Y [--duration MS] [--steps N]
      ghost-mouse-driver move       --x X --y Y [--duration MS] [--steps N]
      ghost-mouse-driver click      --x X --y Y
      ghost-mouse-driver scroll     --x X --y Y --delta D
      ghost-mouse-driver type       --text "hello world" [--delay MS]
      ghost-mouse-driver record     [-o output.json]
      ghost-mouse-driver replay     [-i input.json] [--delay N] [--speed X]
      ghost-mouse-driver info       [-i input.json]
      ghost-mouse-driver screen-info

    COMMANDS:
      move-click   Smoothly move to (x,y) then click (for orchestrator)
      move         Smoothly move to (x,y) without clicking
      click        Click at (x,y) instantly
      scroll       Scroll at position (x,y) by delta lines
      type         Type text using keyboard events
      record       Record mouse events (Ctrl+C to stop)
      replay       Replay a recorded session
      info         Show recording summary
      screen-info  Print screen dimensions as JSON

    OPTIONS:
      --x X           Target X coordinate (screen points)
      --y Y           Target Y coordinate (screen points)
      --duration MS   Move duration in milliseconds (default: 800)
      --steps N       Interpolation steps (default: 60)
      --delta D       Scroll delta (negative = down, positive = up)
      --text TEXT     Text to type
      --delay MS      Delay between keystrokes in ms (default: 50)
      -o FILE         Output file for recording (default: mouse-session.json)
      -i FILE         Input file for replay (default: mouse-session.json)
      --speed X       Replay speed multiplier (default: 1.0)
    """
    fputs(usage + "\n", stderr)
}

func parseFlag(_ flag: String, from args: [String]) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

// MARK: - Main

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "help"

switch command {

case "move-click":
    guard let xStr = parseFlag("--x", from: args), let x = Double(xStr),
          let yStr = parseFlag("--y", from: args), let y = Double(yStr) else {
        fputs("❌ move-click requires --x X --y Y\n", stderr)
        exit(1)
    }
    let duration = Int(parseFlag("--duration", from: args) ?? "800") ?? 800
    let steps = Int(parseFlag("--steps", from: args) ?? "60") ?? 60
    let target = CGPoint(x: x, y: y)

    fputs("🎯 move-click → (\(Int(x)), \(Int(y))) duration=\(duration)ms steps=\(steps)\n", stderr)
    smoothMove(to: target, durationMs: duration, steps: steps)
    Thread.sleep(forTimeInterval: 0.08) // brief pause before click
    click(at: target)
    fputs("✅ Done\n", stderr)

case "move":
    guard let xStr = parseFlag("--x", from: args), let x = Double(xStr),
          let yStr = parseFlag("--y", from: args), let y = Double(yStr) else {
        fputs("❌ move requires --x X --y Y\n", stderr)
        exit(1)
    }
    let duration = Int(parseFlag("--duration", from: args) ?? "800") ?? 800
    let steps = Int(parseFlag("--steps", from: args) ?? "60") ?? 60
    let target = CGPoint(x: x, y: y)

    fputs("➡️  move → (\(Int(x)), \(Int(y))) duration=\(duration)ms\n", stderr)
    smoothMove(to: target, durationMs: duration, steps: steps)
    fputs("✅ Done\n", stderr)

case "click":
    guard let xStr = parseFlag("--x", from: args), let x = Double(xStr),
          let yStr = parseFlag("--y", from: args), let y = Double(yStr) else {
        fputs("❌ click requires --x X --y Y\n", stderr)
        exit(1)
    }
    let point = CGPoint(x: x, y: y)
    click(at: point)
    fputs("✅ Clicked at (\(Int(x)), \(Int(y)))\n", stderr)

case "scroll":
    guard let xStr = parseFlag("--x", from: args), let x = Double(xStr),
          let yStr = parseFlag("--y", from: args), let y = Double(yStr),
          let deltaStr = parseFlag("--delta", from: args), let delta = Int32(deltaStr) else {
        fputs("❌ scroll requires --x X --y Y --delta D\n", stderr)
        exit(1)
    }
    let point = CGPoint(x: x, y: y)
    scrollAt(point: point, deltaY: delta)
    fputs("✅ Scrolled at (\(Int(x)), \(Int(y))) delta=\(delta)\n", stderr)

case "smooth-scroll":
    guard let xStr = parseFlag("--x", from: args), let x = Double(xStr),
          let yStr = parseFlag("--y", from: args), let y = Double(yStr),
          let pixelsStr = parseFlag("--pixels", from: args), let pixels = Int(pixelsStr) else {
        fputs("❌ smooth-scroll requires --x X --y Y --pixels P\n", stderr)
        exit(1)
    }
    let duration = Int(parseFlag("--duration", from: args) ?? "600") ?? 600
    let steps = Int(parseFlag("--steps", from: args) ?? "30") ?? 30
    let point = CGPoint(x: x, y: y)
    fputs("↕️  smooth-scroll at (\(Int(x)), \(Int(y))) pixels=\(pixels) duration=\(duration)ms\n", stderr)
    smoothScroll(at: point, totalPixels: pixels, durationMs: duration, steps: steps)
    fputs("✅ Done\n", stderr)

case "type":
    guard let text = parseFlag("--text", from: args) else {
        fputs("❌ type requires --text TEXT\n", stderr)
        exit(1)
    }
    let delay = Int(parseFlag("--delay", from: args) ?? "50") ?? 50
    fputs("⌨️  Typing \(text.count) chars...\n", stderr)
    typeText(text, delayMs: delay)
    fputs("✅ Done\n", stderr)

case "screen-info":
    let mainDisplay = CGMainDisplayID()
    let w = CGDisplayPixelsWide(mainDisplay)
    let h = CGDisplayPixelsHigh(mainDisplay)
    print("{\"width\":\(w),\"height\":\(h)}")

case "record":
    let file = parseFlag("-o", from: args) ?? "mouse-session.json"
    let recorder = MouseRecorder()

    let signalSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    signal(SIGINT, SIG_IGN)
    signalSource.setEventHandler {
        fputs("\n⏹  Stopping...\n", stderr)
        let recording = recorder.stop()

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(recording) else {
            fputs("❌ Failed to encode recording.\n", stderr)
            exit(1)
        }

        let url = URL(fileURLWithPath: file)
        do {
            try data.write(to: url)
            fputs("💾 Saved \(recording.eventCount) events (\(recording.durationMs)ms) → \(file)\n", stderr)
        } catch {
            fputs("❌ Failed to write file: \(error.localizedDescription)\n", stderr)
            exit(1)
        }
        exit(0)
    }
    signalSource.resume()
    recorder.start()
    CFRunLoopRun()

case "replay":
    let file = parseFlag("-i", from: args) ?? "mouse-session.json"
    let speed = Double(parseFlag("--speed", from: args) ?? "1.0") ?? 1.0
    let delay = Int(parseFlag("--delay", from: args) ?? "3") ?? 3

    let url = URL(fileURLWithPath: file)
    guard let data = try? Data(contentsOf: url) else {
        fputs("❌ Cannot read file: \(file)\n", stderr)
        exit(1)
    }
    guard let recording = try? JSONDecoder().decode(Recording.self, from: data) else {
        fputs("❌ Cannot parse recording from: \(file)\n", stderr)
        exit(1)
    }

    if delay > 0 {
        fputs("⏳ Starting replay in \(delay) seconds...\n", stderr)
        for remaining in stride(from: delay, to: 0, by: -1) {
            fputs("   \(remaining)...\n", stderr)
            Thread.sleep(forTimeInterval: 1.0)
        }
    }

    let replayer = MouseReplayer()
    replayer.replay(recording: recording, speedMultiplier: speed)

case "info":
    let file = parseFlag("-i", from: args) ?? "mouse-session.json"
    let url = URL(fileURLWithPath: file)
    guard let data = try? Data(contentsOf: url) else {
        fputs("❌ Cannot read file: \(file)\n", stderr)
        exit(1)
    }
    guard let recording = try? JSONDecoder().decode(Recording.self, from: data) else {
        fputs("❌ Cannot parse recording from: \(file)\n", stderr)
        exit(1)
    }

    let durationS = Double(recording.durationMs) / 1000.0
    let clickCount = recording.events.filter { $0.type == "down" }.count
    let moveCount = recording.events.filter { $0.type == "move" }.count
    let avgHz = moveCount > 0 ? Double(moveCount) / durationS : 0

    let info = """
    📊 Recording Info: \(file)
       Recorded at:  \(recording.recordedAt)
       Screen:       \(recording.screen.width) × \(recording.screen.height)
       Duration:     \(String(format: "%.2f", durationS))s
       Total events: \(recording.eventCount)
       Mouse moves:  \(moveCount) (~\(Int(avgHz)) Hz)
       Left clicks:  \(clickCount)
    """
    fputs(info + "\n", stderr)

default:
    printUsage()
}
