import Foundation
import AVFoundation
import AppKit

// Read-only visual QA: extract frames without modifying the original movie.
guard (3...4).contains(CommandLine.arguments.count) else { exit(2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero
let duration = CMTimeGetSeconds(asset.duration)
var frames: [[String: Any]] = []
let samples: [Double]
if CommandLine.arguments.count == 4 {
    let values = CommandLine.arguments[3].split(separator: ",")
    samples = values.compactMap { Double($0) }
    guard !samples.isEmpty, samples.count == values.count,
          samples.allSatisfy({ $0.isFinite && $0 >= 0 && $0 < duration }) else { exit(2) }
} else {
    samples = [0.0, 0.5, 1.0, 2.0, 3.0, 4.0, min(5.0, duration - 0.1)]
}
for (index, second) in samples.enumerated() {
    var actual = CMTime.zero
    let cg = try generator.copyCGImage(at: CMTime(seconds: second, preferredTimescale: 600), actualTime: &actual)
    let bitmap = NSBitmapImageRep(cgImage: cg)
    let path = output.appendingPathComponent(String(format: "frame-%02d.png", index))
    try bitmap.representation(using: .png, properties: [:])!.write(to: path)
    frames.append(["requestedSeconds": second, "actualSeconds": CMTimeGetSeconds(actual), "path": path.path])
}
let json = try JSONSerialization.data(withJSONObject: frames, options: [.prettyPrinted, .sortedKeys])
try json.write(to: output.appendingPathComponent("frames.json"))
print(String(data: json, encoding: .utf8)!)
