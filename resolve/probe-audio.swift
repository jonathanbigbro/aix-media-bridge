import Foundation
import AVFoundation
import AudioToolbox

// Fully decode local narration/export audio. No network or media generation.
guard CommandLine.arguments.count == 2 else { exit(2) }
do {
 let asset = AVURLAsset(url:URL(fileURLWithPath:CommandLine.arguments[1]))
 let tracks = asset.tracks(withMediaType:.audio)
 guard tracks.count == 1 else { throw NSError(domain:"REQUIRE_ONE_AUDIO_TRACK",code:1) }
 let track=tracks[0], reader=try AVAssetReader(asset:asset)
 let output=AVAssetReaderTrackOutput(track:track,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMIsFloatKey:true,AVLinearPCMBitDepthKey:32,AVLinearPCMIsNonInterleaved:false,AVSampleRateKey:48000])
 reader.add(output)
 guard reader.startReading() else { throw reader.error! }
 var total=0,peak=0.0,sum=0.0,clipped=0,first:Double?=nil,last=0.0
 var bins=[Int:(Double,Int)](),channels=1
 var channelSums=[Double](),channelPeaks=[Double](),channelCounts=[Int]()
 while let sample=output.copyNextSampleBuffer() {
  guard let block=CMSampleBufferGetDataBuffer(sample),let fmt=CMSampleBufferGetFormatDescription(sample),let info=CMAudioFormatDescriptionGetStreamBasicDescription(fmt) else { throw NSError(domain:"DECODE_SAMPLE",code:2) }
  channels=Int(info.pointee.mChannelsPerFrame)
  if channelSums.isEmpty {channelSums=Array(repeating:0,count:channels);channelPeaks=Array(repeating:0,count:channels);channelCounts=Array(repeating:0,count:channels)}
  let length=CMBlockBufferGetDataLength(block)
  var bytes=[UInt8](repeating:0,count:length)
  guard CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:&bytes)==kCMBlockBufferNoErr else { throw NSError(domain:"DECODE_BUFFER",code:3) }
  let start=CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
  bytes.withUnsafeBytes { raw in
   let values=raw.bindMemory(to:Float.self)
   for (index,v) in values.enumerated() {
    let value=Double(v),absval=abs(value),time=start+Double(index/channels)/48000
    total+=1; sum+=value*value; peak=max(peak,absval)
    let channel=index%channels
    channelSums[channel]+=value*value;channelPeaks[channel]=max(channelPeaks[channel],absval);channelCounts[channel]+=1
    if absval>=0.999 {clipped+=1}
    if absval>0.003 {if first==nil {first=time};last=time}
    let key=Int(floor(time*10)),prev=bins[key] ?? (0,0)
    bins[key]=(prev.0+value*value,prev.1+1)
   }
  }
 }
 guard reader.status == .completed && total>0 else { throw NSError(domain:"AUDIO_DECODE_INCOMPLETE",code:4) }
 let rms=sqrt(sum/Double(total))
 let result:[String:Any] = ["decodeComplete":true,"audioTracks":tracks.count,"sampleRate":48000,"channels":channels,"decodedSamplesPerChannel":total/channels,"audioTrackDurationSeconds":CMTimeGetSeconds(track.timeRange.duration),"containerDurationSeconds":CMTimeGetSeconds(asset.duration),"rmsDbFS":20*log10(max(rms,1e-12)),"peakDbFS":20*log10(max(peak,1e-12)),"clippedSamples":clipped,"firstActiveSeconds":first ?? -1,"lastActiveSeconds":last,"nonSilent":rms>0.001,"envelope100ms":bins.keys.sorted().map{["time":Double($0)/10,"rms":sqrt(bins[$0]!.0/Double(bins[$0]!.1))]}]
 var detailed=result
 detailed["channelRmsDbFS"]=channelSums.enumerated().map{20*log10(max(sqrt($0.element/Double(channelCounts[$0.offset])),1e-12))}
 detailed["channelPeakDbFS"]=channelPeaks.map{20*log10(max($0,1e-12))}
 print(String(data:try JSONSerialization.data(withJSONObject:detailed,options:[.sortedKeys]),encoding:.utf8)!)
} catch {print("{\"error\":\"AUDIO_NOT_VERIFIED\"}");fputs(String(describing:error),stderr);exit(2)}
