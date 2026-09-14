import Foundation
import AVFoundation
import CryptoKit
import CoreVideo

// Local file verification only. No network access, generation, or downloading.
guard (2...3).contains(CommandLine.arguments.count) else {
    fputs("Usage: probe-video PATH [REQUESTED_SECONDS]\n", stderr)
    exit(2)
}
do {
    let requestedDuration = CommandLine.arguments.count == 3 ? Double(CommandLine.arguments[2]) ?? .nan : 4.0
    guard requestedDuration.isFinite && requestedDuration > 0 else { throw NSError(domain: "InvalidDuration", code: 6) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let data = try Data(contentsOf: url)
    guard !data.isEmpty else { throw NSError(domain: "EmptyVideo", code: 1) }
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
        throw NSError(domain: "NoVideoTrack", code: 2)
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? NSError(domain: "ReaderStart", code: 3) }
    var frames = 0
    var firstTime: Double? = nil
    var lastTime = 0.0
    while let sample = output.copyNextSampleBuffer() {
        guard CMSampleBufferGetImageBuffer(sample) != nil else { throw NSError(domain: "DecodeFrame", code: 4) }
        let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
        if firstTime == nil { firstTime = time }
        lastTime = time
        frames += 1
    }
    guard reader.status == .completed && frames > 0 else {
        throw reader.error ?? NSError(domain: "DecodeIncomplete", code: 5)
    }
    let displaySize = track.naturalSize.applying(track.preferredTransform)
    let duration = CMTimeGetSeconds(asset.duration)
    let width = Int(abs(displaySize.width).rounded())
    let height = Int(abs(displaySize.height).rounded())
    let result: [String: Any] = [
        "path": url.path, "bytes": data.count,
        "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
        "durationSeconds": duration, "width": width, "height": height,
        "nominalFrameRate": track.nominalFrameRate, "decodedFrames": frames,
        "firstPresentationSeconds": firstTime ?? 0, "lastPresentationSeconds": lastTime,
        "decodeComplete": true,
        "requestedDurationSeconds": requestedDuration,
        "matchesRequestedDurationExactly": abs(duration - requestedDuration) <= 0.001,
        "durationDeviationSeconds": duration - requestedDuration,
        "matches4SecondsExactly": abs(duration - 4.0) <= 0.001,
        "within150MillisecondsOf4Seconds": abs(duration - 4.0) <= 0.15,
        "videoTrackDurationSeconds": CMTimeGetSeconds(track.timeRange.duration),
        "matches720p16by9": width == 1280 && height == 720,
        "verifier": "macOS AVFoundation decoded every video frame; CryptoKit SHA256"
    ]
    let json = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    print(String(data: json, encoding: .utf8)!)
} catch {
    let result = ["error": String(describing: error), "state": "not-verified"]
    if let json = try? JSONSerialization.data(withJSONObject: result), let text = String(data: json, encoding: .utf8) { print(text) }
    exit(2)
}
