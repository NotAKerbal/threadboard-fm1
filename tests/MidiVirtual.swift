import Foundation
import CoreMIDI
var client=MIDIClientRef(), source=MIDIEndpointRef(), destination=MIDIEndpointRef()
let lock=NSLock()
func emit(_ value:[String:Any]) {
    guard let data=try? JSONSerialization.data(withJSONObject:value) else{return}
    lock.lock();FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]));lock.unlock()
}
guard MIDIClientCreateWithBlock("Threadboard test" as CFString,&client,nil)==noErr,
      MIDISourceCreate(client,"Threadboard Test" as CFString,&source)==noErr else {exit(1)}
guard MIDIDestinationCreateWithBlock(client,"Threadboard Test" as CFString,&destination,{packets,_ in
    var p=UnsafeRawPointer(packets).advanced(by:MemoryLayout<MIDIPacketList>.offset(of: \.packet)!).assumingMemoryBound(to:MIDIPacket.self)
    for _ in 0..<packets.pointee.numPackets {
        let bytes=UnsafeRawPointer(p).advanced(by:MemoryLayout<MIDIPacket>.offset(of: \.data)!).assumingMemoryBound(to:UInt8.self)
        emit(["bytes":Array(UnsafeBufferPointer(start:bytes,count:Int(p.pointee.length)))])
        p=UnsafePointer(MIDIPacketNext(p))
    }
    _=MIDIReceived(source,packets)
})==noErr else {exit(1)}
print("READY");fflush(stdout)
DispatchQueue.global().async {
    while let line=readLine() {
        guard let data=line.data(using:.utf8),let obj=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let bytes=obj["bytes"] as? [UInt8],!bytes.isEmpty,bytes.count<4096 else{continue}
        let size=max(MemoryLayout<MIDIPacketList>.size,bytes.count+128)
        let raw=UnsafeMutableRawPointer.allocate(byteCount:size,alignment:MemoryLayout<MIDIPacketList>.alignment)
        let list=raw.bindMemory(to:MIDIPacketList.self,capacity:1),first=MIDIPacketListInit(raw.assumingMemoryBound(to:MIDIPacketList.self))
        _=bytes.withUnsafeBufferPointer{MIDIPacketListAdd(list,size,first,0,bytes.count,$0.baseAddress!)}
        _=MIDIReceived(source,list);raw.deallocate()
    }
    MIDIClientDispose(client);exit(0)
}
dispatchMain()
