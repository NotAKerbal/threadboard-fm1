import Foundation
import CoreMIDI

let argIndex = CommandLine.arguments.firstIndex(of: "--name")
let wanted = argIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil } ?? "Felucca"
let listing = CommandLine.arguments.contains("--list")
let queue = DispatchQueue(label: "threadboard.midi")
let outputLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    outputLock.lock(); FileHandle.standardOutput.write(line.data(using: .utf8)!); outputLock.unlock()
}
func name(_ endpoint: MIDIEndpointRef) -> String {
    var result: Unmanaged<CFString>?
    if MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &result) == noErr, let value = result?.takeRetainedValue() { return value as String }
    return "Unknown MIDI endpoint"
}
func sources() -> [MIDIEndpointRef] { (0..<MIDIGetNumberOfSources()).map { MIDIGetSource($0) }.filter { $0 != 0 } }
func destinations() -> [MIDIEndpointRef] { (0..<MIDIGetNumberOfDestinations()).map { MIDIGetDestination($0) }.filter { $0 != 0 } }
if listing {
    emit(["sources": sources().map { name($0) }, "destinations": destinations().map { name($0) }]); exit(0)
}
var client = MIDIClientRef(), input = MIDIPortRef(), output = MIDIPortRef()
var source = MIDIEndpointRef(), destination = MIDIEndpointRef()
var lastStatus = ""
func refresh() {
    let ins = sources().filter { name($0).localizedCaseInsensitiveContains(wanted) }
    let outs = destinations().filter { name($0).localizedCaseInsensitiveContains(wanted) }
    let nextSource = ins.count == 1 && outs.count == 1 ? ins[0] : 0
    let nextDestination = ins.count == 1 && outs.count == 1 ? outs[0] : 0
    if source != nextSource {
        if source != 0 { MIDIPortDisconnectSource(input, source) }
        source = nextSource
        if source != 0 { MIDIPortConnectSource(input, source, nil) }
    }
    destination = nextDestination
    let connected = source != 0 && destination != 0
    let error = ins.count > 1 || outs.count > 1 ? "More than one matching FM-1. Use --midi-name to choose a unique endpoint." : ""
    let status = "\(source):\(destination):\(error)"
    if status != lastStatus {
        lastStatus = status
        emit(["type": "status", "connected": connected, "name": connected ? name(source) : wanted, "error": error.isEmpty ? NSNull() : error as Any])
    }
}
let rc = MIDIClientCreateWithBlock("Threadboard" as CFString, &client) { notification in
    let id = notification.pointee.messageID
    if id == .msgObjectAdded || id == .msgObjectRemoved || id == .msgSetupChanged { queue.async { refresh() } }
}
guard rc == noErr else { emit(["type":"status", "connected":false, "error":"Could not create the CoreMIDI client (\(rc))."]); exit(1) }
let inputRC = MIDIInputPortCreateWithBlock(client, "Threadboard input" as CFString, &input) { packetList, _ in
    var pointer = UnsafeRawPointer(packetList).advanced(by: MemoryLayout<MIDIPacketList>.offset(of: \.packet)!).assumingMemoryBound(to: MIDIPacket.self)
    for _ in 0..<packetList.pointee.numPackets {
        let length = Int(pointer.pointee.length)
        let data = UnsafeRawPointer(pointer).advanced(by: MemoryLayout<MIDIPacket>.offset(of: \.data)!).assumingMemoryBound(to: UInt8.self)
        emit(["type":"midi", "bytes": Array(UnsafeBufferPointer(start: data, count: length))])
        pointer = UnsafePointer(MIDIPacketNext(pointer))
    }
}
let outputRC = MIDIOutputPortCreate(client, "Threadboard output" as CFString, &output)
guard inputRC == noErr && outputRC == noErr else { emit(["type":"status", "connected":false, "error":"Could not create CoreMIDI ports."]); exit(1) }
func send(_ bytes: [UInt8]) {
    guard destination != 0 && !bytes.isEmpty && bytes.count <= 4096 else { return }
    let size = max(MemoryLayout<MIDIPacketList>.size, bytes.count + 128)
    let raw = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: MemoryLayout<MIDIPacketList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to: MIDIPacketList.self, capacity: 1)
    let first = MIDIPacketListInit(list)
    _ = bytes.withUnsafeBufferPointer { MIDIPacketListAdd(list, size, first, 0, bytes.count, $0.baseAddress!) }
    _ = MIDISend(output, destination, list)
}
queue.async { refresh() }
let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now() + 2, repeating: 2); timer.setEventHandler { refresh() }; timer.resume()
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let values = object["bytes"] as? [Int], !values.isEmpty, values.count <= 4096, values.allSatisfy({ $0 >= 0 && $0 <= 255 }) else { continue }
        let bytes = values.map { UInt8($0) }; queue.async { send(bytes) }
    }
    MIDIClientDispose(client); exit(0)
}
dispatchMain()
