import Foundation
import AVFoundation
import AppKit

// Local QA only: decode every frame, inspect configured mask cores, and export
// contact sheets for human review. Pixel checks do not identify private content.
guard CommandLine.arguments.count == 4 else { exit(2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let config = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))) as! [String: Any]
let output = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let cases = config["cases"] as! [[String: Any]]
let privacy = config["privacy"] as! [String: [String: [[Double]]]]
let reader = try AVAssetReader(asset: asset)
let track = asset.tracks(withMediaType: .video)[0]
let source = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(source)
guard reader.startReading() else { exit(2) }
var count = 0, maskedFrames = 0
var failures = [Int]()
func geometry(_ points: [[Double]], _ second: Double) -> [Double] {
    for (a,b) in zip(points, points.dropFirst()) where second <= b[0] {
        let f = max(0, min(1, (second-a[0])/(b[0]-a[0])))
        return zip(a,b).map { $0 + ($1-$0)*f }
    }
    return points.last!
}
while let sample = source.copyNextSampleBuffer() {
    defer { count += 1 }
    let index = count / 120
    guard index < cases.count else { failures.append(count); continue }
    if let points = privacy[cases[index]["key"] as! String]?["video"], let buffer = CMSampleBufferGetImageBuffer(sample) {
        maskedFrames += 1
        let g = geometry(points, Double(count % 120)/24)
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        let data = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        var bright = 0, pixels = 0
        let cx = g[1]*Double(width), cy = (1-g[2])*Double(height)
        let angle = -g[5]*Double.pi/180
        for y in -4...4 { for x in -12...12 {
            let dx = Double(x)*g[3]*Double(width)/48
            let dy = Double(y)*g[4]*Double(height)/16
            let px = Int((cx+dx*cos(angle)-dy*sin(angle)).rounded())
            let py = Int((cy+dx*sin(angle)+dy*cos(angle)).rounded())
            guard px >= 0 && px < width && py >= 0 && py < height else { bright += 1; pixels += 1; continue }
            let pos = py*stride+px*4
            if max(data[pos],data[pos+1],data[pos+2]) > 16 { bright += 1 }
            pixels += 1
        }}
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
        if Double(bright)/Double(pixels) > 0.02 { failures.append(count) }
    }
}
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
for caseIndex in cases.indices {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1920, pixelsHigh: 1080,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    for (cell, frame) in [0,15,30,45,60,75,90,105,119].enumerated() {
        let image = try generator.copyCGImage(at: CMTime(value: Int64(caseIndex*120+frame), timescale: 24), actualTime: nil)
        NSImage(cgImage: image, size: NSSize(width: 1280,height:720)).draw(in: NSRect(x:(cell%3)*640,y:(2-cell/3)*360,width:640,height:360))
    }
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("shot-\(caseIndex+1)-contact.png"))
}
let result: [String: Any] = ["decodedFrames": count, "decoderCompleted": reader.status == .completed,
    "maskedFramesChecked": maskedFrames,"maskCoreFailures": failures,"contactSheets": cases.count,
    "humanReviewStillRequired": true,"audioTracks": asset.tracks(withMediaType: .audio).count]
let json = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted,.sortedKeys])
try json.write(to: output.appendingPathComponent("pixel-review.json"))
print(String(data:json,encoding:.utf8)!)
if reader.status != .completed || count != cases.count*120 || !failures.isEmpty { exit(2) }
