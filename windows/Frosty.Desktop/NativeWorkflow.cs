using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Frosty.Desktop;

/// <summary>Native desktop media workflow bridge. Uses the same project JSON owned by the C++ core.</summary>
internal static class NativeWorkflow
{
    private static string N(double value) => value.ToString("0.######", CultureInfo.InvariantCulture);
    private sealed record Clip(string Id, string Path, string Kind, string TrackId, bool Muted, bool Visible,
        double Start, double In, double Out, double Rate, double Volume, double Opacity, double TrackGain, double TrackOpacity, int Order, bool HasAudio,
        double TransformX, double TransformY, double ScaleX, double ScaleY, double Rotation, double ShearX, double ShearY, JsonElement Effects, JsonElement Mask, JsonElement Keyframes, JsonElement LegacyFields, JsonElement TrackEffects);

    public static async Task ExportAsync(string projectJson, string destination, double brightness, double contrast,
        double saturation, double blur, double masterGain, string videoEncoder, IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var workspace=Path.Combine(Path.GetTempPath(),"frosty-native-export-"+Guid.NewGuid().ToString("N")); Directory.CreateDirectory(workspace);
        try { await ExportSequenceInternalAsync(projectJson,destination,brightness,contrast,saturation,blur,masterGain,videoEncoder,progress,cancellationToken,null,0,new HashSet<string>(StringComparer.Ordinal),new Dictionary<string,string>(StringComparer.Ordinal),workspace); }
        finally { try { Directory.Delete(workspace,true); } catch { } }
    }

    public static async Task<bool> RenderPreviewAudioAsync(string projectJson,string destination,CancellationToken cancellationToken=default,IReadOnlyDictionary<string,string>? nestedCache=null)
    {
        using var doc=JsonDocument.Parse(projectJson);var root=doc.RootElement;var assets=root.GetProperty("assets").EnumerateArray().ToDictionary(a=>S(a,"id"),a=>S(a,"path"));var seqId=S(root,"activeSequenceId");var seq=root.GetProperty("sequences").EnumerateArray().FirstOrDefault(s=>S(s,"id")==seqId);if(seq.ValueKind!=JsonValueKind.Object)seq=root.GetProperty("sequences").EnumerateArray().FirstOrDefault();if(seq.ValueKind!=JsonValueKind.Object)return false;
        var tracks=seq.GetProperty("tracks").EnumerateArray().ToDictionary(t=>S(t,"id"),t=>new{Muted=B(t,"muted"),Solo=B(t,"solo"),Visible=B(t,"visible",true),Gain=Math.Max(0,D(t,"gain",1))});bool anySolo=tracks.Values.Any(t=>t.Solo);
        var clips=new List<(string Path,string Kind,double Start,double In,double Out,double Rate,double Volume,double Gain,string Id)>();
        foreach(var c in seq.GetProperty("clips").EnumerateArray()){var tid=S(c,"trackId");if(!tracks.TryGetValue(tid,out var track)||!track.Visible||track.Muted||(anySolo&&!track.Solo)||!B(c,"enabled",true))continue;var kind=S(c,"mediaType","video");if(kind is "image" or "text" or "title")continue;var nestedId=S(c,"nestedSequenceId");string path;if(!string.IsNullOrWhiteSpace(nestedId)&&nestedCache is not null&&nestedCache.TryGetValue(nestedId,out var nestedPath))path=nestedPath;else{var assetId=S(c,"assetId");if(!assets.TryGetValue(assetId,out var assetPath))continue;path=assetPath;}if(!File.Exists(path)||!ProbeHasAudio(path))continue;var input=D(c,"sourceIn");var output=D(c,"sourceOut");if(output<=input+.01)output=ProbeDuration(path);if(output<=input)continue;clips.Add((path,kind,Math.Max(0,D(c,"timelineStart")),input,output,Math.Clamp(D(c,"playbackRate",1),.5,2),Math.Max(0,D(c,"volume",1)),track.Gain,S(c,"id")));}
        if(clips.Count==0)return false;var args=new List<string>{"-y","-hide_banner","-loglevel","error"};foreach(var c in clips){args.Add("-i");args.Add(c.Path);}var graph=new List<string>();var transitions=seq.TryGetProperty("transitions",out var audioTransitions)&&audioTransitions.ValueKind==JsonValueKind.Array?audioTransitions.EnumerateArray().Where(t=>B(t,"audio",false)).ToList():new List<JsonElement>();for(int i=0;i<clips.Count;i++){var c=clips[i];var delay=(int)Math.Clamp(c.Start*1000,0,int.MaxValue);var chain=new List<string>{$"atrim=start={N(c.In)}:duration={N(c.Out-c.In)}","asetpts=PTS-STARTPTS",Atempo(c.Rate),"aresample=48000","aformat=channel_layouts=stereo",$"volume={N(c.Volume*c.Gain)}"};foreach(var tr in transitions){var type=S(tr,"type","crossfade");if(type=="none")continue;var start=Math.Max(0,D(tr,"start")-c.Start);var dur=Math.Max(.001,D(tr,"duration",.5));if(S(tr,"fromClipId")==c.Id)chain.Add($"afade=t=out:st={N(start)}:d={N(dur)}");if(S(tr,"toClipId")==c.Id)chain.Add($"afade=t=in:st={N(start)}:d={N(dur)}");}chain.Add($"adelay={delay}|{delay}");graph.Add($"[{i}:a]{string.Join(",",chain)}[a{i}]");}graph.Add(string.Join("",Enumerable.Range(0,clips.Count).Select(i=>$"[a{i}]"))+$"amix=inputs={clips.Count}:duration=longest:normalize=0,alimiter=limit=0.98[aout]");args.AddRange(new[]{"-filter_complex",string.Join(";",graph),"-map","[aout]","-c:a","pcm_s16le","-ar","48000","-ac","2",destination});var psi=new ProcessStartInfo{FileName=MediaToolPaths.Ffmpeg,UseShellExecute=false,RedirectStandardError=true,RedirectStandardOutput=true,CreateNoWindow=true};foreach(var a in args)psi.ArgumentList.Add(a);using var process=Process.Start(psi)??throw new InvalidOperationException("Could not start FFmpeg audio monitor render.");var stderr=process.StandardError.ReadToEndAsync(cancellationToken);await process.WaitForExitAsync(cancellationToken);var error=await stderr;if(process.ExitCode!=0||!File.Exists(destination)||new FileInfo(destination).Length<44)throw new InvalidOperationException("Audio monitor mix failed: "+error);return true;
    }

    public static async Task RenderSequenceToFileAsync(string projectJson,string sequenceId,string destination,CancellationToken cancellationToken=default)
    {
        var workspace=Path.Combine(Path.GetTempPath(),"frosty-native-nested-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(workspace);
        try { await ExportSequenceInternalAsync(projectJson,destination,0,1,1,0,1,"libx264",null,cancellationToken,sequenceId,0,new HashSet<string>(StringComparer.Ordinal),new Dictionary<string,string>(StringComparer.Ordinal),workspace); }
        finally { try { Directory.Delete(workspace,true); } catch { } }
    }

    private static async Task ExportSequenceInternalAsync(string projectJson, string destination, double brightness, double contrast,
        double saturation, double blur, double masterGain, string videoEncoder, IProgress<string>? progress,
        CancellationToken cancellationToken, string? sequenceOverride, int depth, HashSet<string> sequenceStack,
        Dictionary<string,string> nestedCache, string workspace)
    {
        if(depth>16) throw new InvalidOperationException("Nested sequence depth exceeds 16; refusing recursive export.");
        using var doc = JsonDocument.Parse(projectJson);
        var root = doc.RootElement;
        var assets = root.GetProperty("assets").EnumerateArray().ToDictionary(x => S(x,"id"), x => S(x,"path"));
        var sequenceId = sequenceOverride ?? S(root,"activeSequenceId");
        var seq = root.GetProperty("sequences").EnumerateArray().FirstOrDefault(x => S(x,"id") == sequenceId);
        if (seq.ValueKind == JsonValueKind.Undefined && sequenceOverride is null) seq = root.GetProperty("sequences").EnumerateArray().FirstOrDefault();
        if (seq.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("The project has no sequence to export.");
        if(sequenceStack.Contains(sequenceId)) throw new InvalidOperationException("Nested sequence cycle detected: "+string.Join(" -> ",sequenceStack.Append(sequenceId)));
        var childStack=new HashSet<string>(sequenceStack,StringComparer.Ordinal){sequenceId};
        var settings = seq.TryGetProperty("settings", out var localSettings) ? localSettings : root.GetProperty("settings");
        int width = Math.Clamp(I(settings,"width",1920), 16, 8192), height = Math.Clamp(I(settings,"height",1080), 16, 8192);
        double fps = Math.Clamp((double)I(settings.GetProperty("frameRate"),"numerator",30) / Math.Max(1,I(settings.GetProperty("frameRate"),"denominator",1)), 1, 120);
        var tracks = seq.GetProperty("tracks").EnumerateArray().ToDictionary(x => S(x,"id"), x => new { Name=S(x,"name"), Order=I(x,"order"), Type=S(x,"type"), Muted=B(x,"muted"), Solo=B(x,"solo"), Visible=B(x,"visible",true), Gain=Math.Max(0,D(x,"gain",1)), Opacity=Math.Clamp(D(x,"opacity",1),0,1) });
        bool anySolo=tracks.Values.Any(t=>t.Solo);
        var transitionRows = new List<(string Type,string From,string To,double Start,double Duration,bool Audio)>();
        if(seq.TryGetProperty("transitions",out var transitionArray) && transitionArray.ValueKind==JsonValueKind.Array) foreach(var t in transitionArray.EnumerateArray()) {
            var isAudio=B(t,"audio",false);
            var type=S(t,"type","crossfade").ToLowerInvariant();
            if(type is not ("crossfade" or "dissolve" or "fade" or "fadeblack" or "none" or "wipeleft" or "wiperight" or "wipeup" or "wipedown" or "slideleft" or "slideright" or "circleopen" or "radial" or "pixelize")) throw new InvalidOperationException($"Transition '{type}' is not implemented by the native renderer yet; replace it with a supported transition before exporting to avoid a misleading output.");
            transitionRows.Add((type,S(t,"fromClipId"),S(t,"toClipId"),Math.Max(0,D(t,"start")),Math.Max(0.001,D(t,"duration",0.5)),isAudio));
        }
        // Older Electron projects store transitions on the incoming clip (clip.trans), not in a sequence-level array.
        if(transitionRows.Count==0 && seq.GetProperty("clips").ValueKind==JsonValueKind.Array) {
            var orderedLegacy=seq.GetProperty("clips").EnumerateArray().OrderBy(c=>D(c,"timelineStart")).ToList();
            foreach(var incoming in orderedLegacy) {
                if(!incoming.TryGetProperty("legacyFields",out var lf)||lf.ValueKind!=JsonValueKind.Object||!lf.TryGetProperty("trans",out var trans)||trans.ValueKind!=JsonValueKind.Object)continue;
                var duration=Math.Max(0,D(trans,"dur",D(trans,"duration")));if(duration<=.05)continue;var trackId=S(incoming,"trackId");var start=Math.Max(0,D(incoming,"timelineStart"));var type=S(trans,"type","dissolve").ToLowerInvariant();
                var previous=orderedLegacy.Where(c=>S(c,"trackId")==trackId&&S(c,"id")!=S(incoming,"id")&&D(c,"timelineStart")<start&&D(c,"timelineStart")+Math.Max(0,D(c,"sourceOut")-D(c,"sourceIn"))>start).OrderByDescending(c=>D(c,"timelineStart")).FirstOrDefault();
                if(previous.ValueKind!=JsonValueKind.Object)continue;if(type is not ("crossfade" or "dissolve" or "fade" or "fadeblack" or "none" or "wipeleft" or "wiperight" or "wipeup" or "wipedown" or "slideleft" or "slideright" or "circleopen" or "radial" or "pixelize"))throw new InvalidOperationException($"Legacy transition '{type}' is not supported by native export.");var from=S(previous,"id");var to=S(incoming,"id");transitionRows.Add((type,from,to,start,duration,false));transitionRows.Add((type,from,to,start,duration,true));
            }
        }
        var clips = new List<Clip>();
        var textOverlays = new List<(double Start,double Duration,string Text,int Size,string Color,string Position,double Opacity)>();
        foreach (var c in seq.GetProperty("clips").EnumerateArray()) {
            var trackId=S(c,"trackId"); var track=tracks.GetValueOrDefault(trackId); if (track is null || !track.Visible || !B(c,"enabled",true)) continue;
            var mediaKind=S(c,"mediaType","video");
            if (mediaKind.Equals("text",StringComparison.OrdinalIgnoreCase) || mediaKind.Equals("title",StringComparison.OrdinalIgnoreCase)) {
                var legacyText = c.TryGetProperty("legacyFields",out var textLegacy) && textLegacy.ValueKind==JsonValueKind.Object ? textLegacy : default;
                var textValue = S(c,"text",S(legacyText,"text",S(c,"name","")));
                var textStart=D(c,"timelineStart"); var textDuration=D(c,"sourceOut"); if(textDuration<=0)textDuration=D(legacyText,"dur",D(c,"duration",3)); if(textDuration<=0)textDuration=3;
                textOverlays.Add((Math.Max(0,textStart),textDuration,textValue,Math.Clamp(I(c,"fontSize",I(legacyText,"size",48)),8,256),S(c,"color",S(legacyText,"color","#FFFFFF")),S(c,"position",S(legacyText,"pos","bottom")),Math.Clamp(D(c,"opacity",1),0,1)));
                continue;
            }
            var nestedId=S(c,"nestedSequenceId");
            string path;
            var resolvedKind=mediaKind;
            if(!string.IsNullOrWhiteSpace(nestedId)) {
                if(!nestedCache.TryGetValue(nestedId,out var cachedNestedPath)) {
                    var nestedSequence=root.GetProperty("sequences").EnumerateArray().FirstOrDefault(x=>S(x,"id")==nestedId);
                    if(nestedSequence.ValueKind!=JsonValueKind.Object) throw new InvalidOperationException($"Nested sequence '{nestedId}' referenced by clip '{S(c,"id")}' does not exist.");
                    path=Path.Combine(workspace,"nested-"+new string(nestedId.Select(ch=>char.IsLetterOrDigit(ch)?ch:'_').Take(64).ToArray())+".mp4");
                    await ExportSequenceInternalAsync(projectJson,path,brightness,contrast,saturation,blur,masterGain,videoEncoder,progress,cancellationToken,nestedId,depth+1,childStack,nestedCache,workspace);
                    nestedCache[nestedId]=path;
                } else { path=cachedNestedPath; }
                resolvedKind="video";
            } else {
                var assetId=S(c,"assetId"); if (!assets.TryGetValue(assetId,out var assetPath)) throw new InvalidOperationException($"Missing media reference for clip '{S(c,"name",S(c,"id"))}' (asset id {assetId})."); path=assetPath; if(!File.Exists(path)) throw new InvalidOperationException($"Missing media for clip '{S(c,"name",S(c,"id"))}': {path}");
            }
            if(!File.Exists(path)) throw new InvalidOperationException($"Resolved media path does not exist: {path}");
            var mask = c.TryGetProperty("legacyFields", out var legacy) && legacy.ValueKind == JsonValueKind.Object && legacy.TryGetProperty("mask", out var m) ? m.Clone() : default;
            var transform = legacy.ValueKind == JsonValueKind.Object && legacy.TryGetProperty("transform", out var tr) && tr.ValueKind == JsonValueKind.Object ? tr : default;
            var transformX = D(transform, "x", D(legacy, "transform.x", 0));
            var transformY = D(transform, "y", D(legacy, "transform.y", 0));
            var scaleX = Math.Clamp(D(transform, "scaleX", D(legacy, "transform.scaleX", 1)), .05, 8);
            var scaleY = Math.Clamp(D(transform, "scaleY", D(legacy, "transform.scaleY", 1)), .05, 8);
            var rotation = D(transform, "rotation", D(legacy, "transform.rotation", 0));
            var shearX = Math.Clamp(D(transform, "shearX", D(legacy, "transform.shearX", 0)), -2, 2);
            var shearY = Math.Clamp(D(transform, "shearY", D(legacy, "transform.shearY", 0)), -2, 2);
            var clipSourceIn=D(c,"sourceIn");var clipSourceOut=D(c,"sourceOut");if(clipSourceOut<=clipSourceIn+.01)clipSourceOut=ProbeDuration(path);
            clips.Add(new Clip(S(c,"id"),path,resolvedKind,trackId,track.Muted || (anySolo && !track.Solo),track.Visible,D(c,"timelineStart"),clipSourceIn,clipSourceOut,Math.Clamp(D(c,"playbackRate",1),.05,16),D(c,"volume",1),Math.Clamp(D(c,"opacity",1),0,1),track.Gain,track.Opacity,track.Order,S(c,"mediaType","video")!="image" && ProbeHasAudio(path),transformX,transformY,scaleX,scaleY,rotation,shearX,shearY,c.TryGetProperty("effects",out var fx)?fx:default,mask,c.TryGetProperty("keyframes",out var kf)?kf.Clone():default,legacy.ValueKind==JsonValueKind.Object?legacy.Clone():default,GetLegacyTrackEffects(root,sequenceId,trackId,track?.Name??"")));
        }
        if (clips.Count==0 && textOverlays.Count==0) throw new InvalidOperationException("The active sequence contains no enabled video, image, or text clips.");
        double duration=Math.Max(clips.Count>0 ? clips.Max(c=>c.Start+Math.Max(0,c.Out-c.In)/c.Rate) : 0, textOverlays.Count>0 ? textOverlays.Max(t=>t.Start+t.Duration) : 0); if(duration<=0) throw new InvalidOperationException("Sequence duration is zero.");
        string? maskWorkspace = null; string? textAssPath = null;
        try
        {
        var maskVideos = new Dictionary<string, string>(StringComparer.Ordinal);
        var maskedClips = clips.Where(c => c.Kind != "audio" && TryGetEnabledBezierMask(c.Mask, out _)).ToList();
        if (maskedClips.Count > 0)
        {
            maskWorkspace = Path.Combine(Path.GetTempPath(), "frosty-bezier-mattes-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(maskWorkspace);
            foreach (var clip in maskedClips)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!TryGetEnabledBezierMask(clip.Mask, out var mask) || mask is null) continue;
                var clipDuration = Math.Max(1 / fps, Math.Max(0, clip.Out - clip.In) / clip.Rate);
                var safeId = new string(clip.Id.Select(ch => char.IsLetterOrDigit(ch) ? ch : '_').Take(48).ToArray());
                maskVideos[clip.Id] = await BezierMaskModel.CreateMatteVideoAsync(mask, fps, clipDuration, width, height, maskWorkspace, safeId + "-" + maskVideos.Count.ToString(CultureInfo.InvariantCulture), cancellationToken);
            }
        }
        var args=new List<string>{"-y","-hide_banner","-loglevel","warning","-progress","pipe:1","-f","lavfi","-i",$"color=c=black:s={width}x{height}:r={N(fps)}:d={N(duration)}"};
        var inputIndex=new Dictionary<string,int>();
        foreach(var c in clips.OrderBy(c=>c.Start).ThenBy(c=>c.Order)) { inputIndex[c.Id]=inputIndex.Count+1; if(c.Kind=="image") args.AddRange(new[]{"-loop","1"}); args.Add("-i"); args.Add(c.Path); }
        var maskInputIndex = new Dictionary<string,int>(StringComparer.Ordinal);
        foreach(var pair in maskVideos) { var idx=clips.Count+1+maskInputIndex.Count; maskInputIndex[pair.Key]=idx; if (Path.GetExtension(pair.Value).Equals(".png",StringComparison.OrdinalIgnoreCase)) args.AddRange(new[]{"-loop","1","-framerate",N(fps)}); args.Add("-i"); args.Add(pair.Value); }
        var graph=new List<string>{$"[0:v]format=rgba[base0]"}; string current="base0"; int layer=0;
        foreach(var c in clips.Where(c=>c.Kind!="audio").OrderBy(c=>c.Order).ThenBy(c=>c.Start)) {
            int idx=inputIndex[c.Id]; double len=Math.Max(.001,(c.Out-c.In)/c.Rate); string label=$"v{idx}"; var localTime=$"(t-{N(c.Start)})";
            var filters=new List<string>{$"trim=start={N(c.In)}:duration={N(c.Out-c.In)}","setpts=(PTS-STARTPTS)/"+N(c.Rate)+"+"+N(c.Start)+"/TB",$"fps={N(fps)}",$"scale={width}:{height}:force_original_aspect_ratio=decrease","pad="+$"{width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black@0","format=rgba"};
            AppendLegacyFx(filters,c.LegacyFields,c.Id);
            AppendEffects(filters,c.Effects,localTime,c.Id,c.LegacyFields);
            AppendEffects(filters,c.TrackEffects,$"t",$"track:{c.TrackId}");
            if(brightness!=0 || contrast!=1 || saturation!=1) filters.Add($"eq=brightness={N(brightness)}:contrast={N(contrast)}:saturation={N(saturation)}");
            if(blur>0) filters.Add($"gblur=sigma={N(Math.Clamp(blur,0,20))}");
            // Keep transformed frames on a fixed-size transparent canvas so layer compositing,
            // alpha mattes, preview/export dimensions, and timing remain aligned.
            var sx=KeyframeExpression(c.Keyframes,"scaleX",c.ScaleX,localTime); var sy=KeyframeExpression(c.Keyframes,"scaleY",c.ScaleY,localTime);
            var rot=KeyframeExpression(c.Keyframes,"rotation",c.Rotation,localTime); var opacity=KeyframeExpression(c.Keyframes,"opacity",c.Opacity*c.TrackOpacity,$"(T-{N(c.Start)})");
            var tx=KeyframeExpression(c.Keyframes,"x",c.TransformX,localTime); var ty=KeyframeExpression(c.Keyframes,"y",c.TransformY,localTime); var shxExpr=KeyframeExpression(c.Keyframes,"shearX",c.ShearX,localTime); var shyExpr=KeyframeExpression(c.Keyframes,"shearY",c.ShearY,localTime);
            var transitionTerms=new List<string>();
            foreach(var trn in transitionRows.Where(t=>!t.Audio)) {
                if(trn.Type is "crossfade" or "dissolve" or "fade" or "fadeblack") {
                    if(trn.From==c.Id) transitionTerms.Add($"if(between(T,{N(trn.Start)},{N(trn.Start+trn.Duration)}),max(0,min(1,1-(T-{N(trn.Start)})/{N(trn.Duration)})),1)");
                    if(trn.To==c.Id) transitionTerms.Add($"if(between(T,{N(trn.Start)},{N(trn.Start+trn.Duration)}),max(0,min(1,(T-{N(trn.Start)})/{N(trn.Duration)})),1)");
                }
                if(trn.Type is "slideleft" or "slideright") { var ratio=$"max(0,min(1,(t-{N(trn.Start)})/{N(trn.Duration)}))"; if(trn.To==c.Id) tx=$"({tx})+if(between(t,{N(trn.Start)},{N(trn.Start+trn.Duration)}),{(trn.Type=="slideleft"?$"(1-({ratio}))":$"(({ratio})-1)")},0)"; if(trn.From==c.Id) tx=$"({tx})+if(between(t,{N(trn.Start)},{N(trn.Start+trn.Duration)}),{(trn.Type=="slideleft"?$"-({ratio})":$"({ratio})")},0)"; }
            }
            if(transitionTerms.Count>0) opacity="("+opacity+")*"+string.Join("*",transitionTerms);
            bool animatedTransform=HasKeyframes(c.Keyframes,"scaleX","scaleY","rotation","opacity","alpha","x","y","shearX","shearY") || transitionRows.Any(t=>!t.Audio&&(t.From==c.Id||t.To==c.Id)&&(t.Type is "slideleft" or "slideright"));
            if (Math.Abs(c.ScaleX-1)>.0001 || Math.Abs(c.ScaleY-1)>.0001 || Math.Abs(c.Rotation)>.0001 || Math.Abs(c.ShearX)>.0001 || Math.Abs(c.ShearY)>.0001 || Math.Abs(c.TransformX)>.0001 || Math.Abs(c.TransformY)>.0001 || animatedTransform)
            {
                if (Math.Abs(c.ScaleX-1)>.0001 || Math.Abs(c.ScaleY-1)>.0001 || HasKeyframes(c.Keyframes,"scaleX","scaleY")) filters.Add($"scale=w='max(2,iw*max(0.05,min(8,{sx})))':h='max(2,ih*max(0.05,min(8,{sy})))':eval=frame");
                if(HasKeyframes(c.Keyframes,"shearX","shearY")) filters.Add($"perspective=x0=0:y0=0:x1=W:y1='({shyExpr})*W':x2='({shxExpr})*H':y2=H:x3='W+({shxExpr})*H':y3='H+({shyExpr})*W':eval=frame:sense=destination");
                else if (Math.Abs(c.ShearX)>.0001 || Math.Abs(c.ShearY)>.0001) filters.Add($"shear=shx={N(c.ShearX)}:shy={N(c.ShearY)}:fillcolor=black@0");
                if (Math.Abs(c.Rotation)>.0001 || HasKeyframes(c.Keyframes,"rotation")) filters.Add($"rotate=a='({rot})*PI/180':ow=rotw(iw):oh=roth(ih):c=black@0");
                filters.Add($"pad=w='max(iw,{width})':h='max(ih,{height})':x='(ow-iw)/2':y='(oh-ih)/2':color=black@0");
                filters.Add($"crop={width}:{height}:x='max(0,min(iw-{width},(iw-{width})/2-({tx})*{width}))':y='max(0,min(ih-{height},(ih-{height})/2-({ty})*{height}))'");
                filters.Add("format=rgba");
            }
            foreach(var trn in transitionRows.Where(t=>!t.Audio && (t.From==c.Id||t.To==c.Id))) {
                bool incoming=trn.To==c.Id;var ratio=incoming?$"max(0,min(1,(T-{N(trn.Start)})/{N(trn.Duration)}))":$"max(0,min(1,1-(T-{N(trn.Start)})/{N(trn.Duration)}))";
                if(trn.Type=="wipeleft") filters.Add($"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W*({ratio})),alpha(X,Y),0)'");
                else if(trn.Type=="wiperight") filters.Add($"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(X,W*(1-({ratio}))),alpha(X,Y),0)'");
                else if(trn.Type=="wipeup") filters.Add($"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(Y,H*({ratio})),alpha(X,Y),0)'");
                else if(trn.Type=="wipedown") filters.Add($"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(Y,H*(1-({ratio}))),alpha(X,Y),0)'");
                else if(trn.Type is "circleopen" or "radial") filters.Add($"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-W/2,2)+pow(Y-H/2,2),pow(min(W,H)/2*({ratio}),2)),alpha(X,Y),0)'");
                else if(trn.Type=="pixelize") {var pixelRatio=incoming?$"max(0.03,min(1,(t-{N(trn.Start)})/{N(trn.Duration)}))":$"max(0.03,min(1,1-(t-{N(trn.Start)})/{N(trn.Duration)}))";filters.Add($"scale=w='max(2,trunc({width}*({pixelRatio})/8)*8)':h='max(2,trunc({height}*({pixelRatio})/8)*8)':eval=frame,scale={width}:{height}:flags=neighbor");}
            }
            if(maskInputIndex.TryGetValue(c.Id,out var maskIdx))
            {
                var pre=$"vpre{idx}"; var matte=$"m{idx}"; var masked=$"vmask{idx}";
                var rgb=$"vrgb{idx}"; var alphaSrc=$"vasrc{idx}"; var origAlpha=$"vaorig{idx}"; var combinedAlpha=$"vacombined{idx}";
                graph.Add($"[{idx}:v]{string.Join(",",filters)}[{pre}]");
                graph.Add($"[{pre}]split=2[{rgb}][{alphaSrc}]");
                graph.Add($"[{alphaSrc}]alphaextract[{origAlpha}]");
                graph.Add($"[{maskIdx}:v]trim=duration={N(len)},setpts=PTS-STARTPTS+{N(c.Start)}/TB,fps={N(fps)},format=gray[{matte}]");
                graph.Add($"[{origAlpha}][{matte}]blend=all_mode=multiply:all_opacity=1[{combinedAlpha}]");
                graph.Add($"[{rgb}][{combinedAlpha}]alphamerge[{masked}]");
                graph.Add($"[{masked}]geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*max(0,min(1,{opacity}))'[{label}]");
            }
            else { filters.Add($"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*max(0,min(1,{opacity}))'"); graph.Add($"[{idx}:v]{string.Join(",",filters)}[{label}]"); }
            string next=$"base{++layer}";
            graph.Add($"[{current}][{label}]overlay=0:0:eof_action=pass:repeatlast=0:enable='between(t,{N(c.Start)},{N(c.Start+len)})'[{next}]"); current=next;
        }
        if(textOverlays.Count>0) {
            var assPath=Path.Combine(Path.GetTempPath(),"frosty-text-"+Guid.NewGuid().ToString("N")+".ass");
            try {
                var sb=new StringBuilder(); sb.AppendLine("[Script Info]").AppendLine("ScriptType: v4.00+").AppendLine($"PlayResX: {width}").AppendLine($"PlayResY: {height}").AppendLine("[V4+ Styles]").AppendLine("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding").AppendLine("Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,36,1").AppendLine("[Events]").AppendLine("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
                foreach(var t in textOverlays) {
                    var align=t.Position.ToLowerInvariant() switch { "top"=>8,"center" or "middle"=>5,"left"=>1,"right"=>3,_=>2 };
                    var escaped=t.Text.Replace("\\","\\\\").Replace("{","\\{").Replace("}","\\}").Replace("\r"," ").Replace("\n","\\N");
                    var color=AssColor(t.Color,t.Opacity);
                    sb.Append("Dialogue: 0,").Append(AssTime(t.Start)).Append(',').Append(AssTime(t.Start+t.Duration)).Append(",Default,,0,0,0,,{\\an").Append(align).Append("\\fs").Append(Math.Clamp(t.Size*(height/720.0),8,256).ToString("0",CultureInfo.InvariantCulture)).Append("\\1c").Append(color).Append("}").AppendLine(escaped);
                }
                await File.WriteAllTextAsync(assPath,sb.ToString(),new UTF8Encoding(false),cancellationToken);
                graph.Add($"[{current}]ass='{assPath.Replace("\\","/").Replace(":","\\:").Replace("'","\\'")}'[withText]"); current="withText";
            } finally { /* removed after FFmpeg exits below */ }
            textAssPath=assPath;
        }
        var masterEffects=GetLegacyMasterEffects(root,sequenceId);
        if(masterEffects.ValueKind==JsonValueKind.Array){var masterFilters=new List<string>();AppendEffects(masterFilters,masterEffects,"t","master");if(masterFilters.Count>0){graph.Add($"[{current}]{string.Join(",",masterFilters)}[masterFx]");current="masterFx";}}
        graph.Add($"[{current}]format=yuv420p[vout]");
        var audioLabels=new List<string>(); int ai=0;
        foreach(var c in clips.Where(c=>(c.Kind=="audio" || c.HasAudio) && !c.Muted)) {
            int idx=inputIndex[c.Id]; string label=$"a{++ai}"; double len=Math.Max(.001,(c.Out-c.In)/c.Rate); int delay=(int)Math.Clamp(c.Start*1000,0,int.MaxValue);
            var audioFilters=new List<string>{$"atrim=start={N(c.In)}:duration={N(c.Out-c.In)}","asetpts=PTS-STARTPTS",Atempo(c.Rate),"aresample=48000","aformat=channel_layouts=stereo"};
            var audioGain=KeyframeExpression(c.Keyframes,"volume",c.Volume,"t"); audioFilters.Add($"volume='({audioGain})*{N(c.TrackGain*masterGain)}':eval=frame");
            foreach(var trn in transitionRows.Where(t=>t.Audio)) { if(trn.Type!="none"&&trn.From==c.Id){var localStart=Math.Max(0,trn.Start-c.Start);audioFilters.Add($"afade=t=out:st={N(localStart)}:d={N(trn.Duration)}");} if(trn.Type!="none"&&trn.To==c.Id){var localStart=Math.Max(0,trn.Start-c.Start);audioFilters.Add($"afade=t=in:st={N(localStart)}:d={N(trn.Duration)}");} }
            audioFilters.Add($"adelay={delay}|{delay}"); graph.Add($"[{idx}:a]{string.Join(",",audioFilters)}[{label}]"); audioLabels.Add($"[{label}]");
        }
        if(audioLabels.Count>0) graph.Add($"{string.Join("",audioLabels)}amix=inputs={audioLabels.Count}:duration=longest:normalize=0,alimiter=limit=0.98[aout]");
        args.AddRange(new[]{"-filter_complex",string.Join(";",graph),"-map","[vout]"}); if(audioLabels.Count>0) args.AddRange(new[]{"-map","[aout]"});
        args.AddRange(new[]{"-t",N(duration),"-r",N(fps),"-c:v",videoEncoder,"-pix_fmt","yuv420p","-movflags","+faststart"}); if(audioLabels.Count>0) args.AddRange(new[]{"-c:a","aac","-b:a","192k"}); args.Add(destination);
        progress?.Report("Starting FFmpeg render…");
        var psi=new ProcessStartInfo{FileName=MediaToolPaths.Ffmpeg,UseShellExecute=false,RedirectStandardError=true,RedirectStandardOutput=true,CreateNoWindow=true}; foreach(var a in args) psi.ArgumentList.Add(a);
        using var p=Process.Start(psi)??throw new InvalidOperationException("Could not start FFmpeg. Install FFmpeg separately and ensure it is on PATH, or set FROSTY_FFMPEG to its full path.");
        var stderr=p.StandardError.ReadToEndAsync(cancellationToken); string? line;
        while((line=await p.StandardOutput.ReadLineAsync(cancellationToken)) is not null) { if(line.StartsWith("out_time=")) progress?.Report("Rendering: "+line[9..]); else if(line.StartsWith("progress=")) progress?.Report(line[9..]=="end"?"Finalizing export…":"Rendering…"); }
        await p.WaitForExitAsync(cancellationToken); var err=await stderr;
        if(p.ExitCode!=0 || !File.Exists(destination) || new FileInfo(destination).Length<128) throw new InvalidOperationException("FFmpeg export failed: "+err);
        progress?.Report("Export complete: "+destination);
        }
        finally { if (maskWorkspace is not null) try { Directory.Delete(maskWorkspace, true); } catch { } if(textAssPath is not null) try { File.Delete(textAssPath); } catch { } }
    }

    private static JsonElement FindLegacyEffectKeyframes(JsonElement legacyFields,JsonElement currentEffect){if(legacyFields.ValueKind!=JsonValueKind.Object||!legacyFields.TryGetProperty("effects",out var legacyEffects)||legacyEffects.ValueKind!=JsonValueKind.Array)return default;var id=S(currentEffect,"id");var type=S(currentEffect,"type",S(currentEffect,"name"));foreach(var candidate in legacyEffects.EnumerateArray()){if((!string.IsNullOrEmpty(id)&&S(candidate,"id")==id)||S(candidate,"type",S(candidate,"name"))==type){if(candidate.TryGetProperty("keyframes",out var keys)&&keys.ValueKind==JsonValueKind.Object)return candidate;}}return default;}
    public static JsonElement GetClipKeyframes(JsonElement clip,JsonElement legacyFields=default){if(clip.TryGetProperty("keyframes",out var current)&&current.ValueKind==JsonValueKind.Array&&current.GetArrayLength()>0)return current.Clone();if(legacyFields.ValueKind!=JsonValueKind.Object&&clip.TryGetProperty("legacyFields",out var legacy))legacyFields=legacy;if(legacyFields.ValueKind!=JsonValueKind.Object||!legacyFields.TryGetProperty("keyframes",out var source)||source.ValueKind!=JsonValueKind.Object){using var empty=JsonDocument.Parse("[]");return empty.RootElement.Clone();}var points=new JsonArray();foreach(var property in source.EnumerateObject()){if(property.Value.ValueKind!=JsonValueKind.Array)continue;foreach(var point in property.Value.EnumerateArray()){var item=new JsonObject{{"property",property.Name},{"time",D(point,"t",D(point,"time",0))},{"value",D(point,"v",D(point,"value",0))},{"interpolation",S(point,"interpolation","linear")}};points.Add(item);}}using var normalized=JsonDocument.Parse(points.ToJsonString());return normalized.RootElement.Clone();}
    public static string BuildPreviewEffectStack(JsonElement root,string sequenceId,JsonElement clip,string trackId,string trackName){var combined=new JsonArray();if(clip.TryGetProperty("effects",out var effects)&&effects.ValueKind==JsonValueKind.Array)foreach(var fx in effects.EnumerateArray()){var node=JsonNode.Parse(fx.GetRawText()) as JsonObject;if(node is not null&&!node.ContainsKey("keyframes")){var keyframes=FindLegacyEffectKeyframes(clip.TryGetProperty("legacyFields",out var clipLegacy)?clipLegacy:default,fx);if(keyframes.ValueKind==JsonValueKind.Object&&keyframes.TryGetProperty("keyframes",out var keyframeObject))node["keyframes"]=JsonNode.Parse(keyframeObject.GetRawText());}combined.Add(node);}if(clip.TryGetProperty("legacyFields",out var legacy)&&legacy.ValueKind==JsonValueKind.Object&&legacy.TryGetProperty("fx",out var legacyFx)&&legacyFx.ValueKind==JsonValueKind.Object)foreach(var prop in legacyFx.EnumerateObject()){var type=prop.Name.ToLowerInvariant();var value=prop.Value;var enabled=value.ValueKind==JsonValueKind.True||value.ValueKind==JsonValueKind.Object||value.ValueKind==JsonValueKind.Number&&value.TryGetDouble(out var num)&&Math.Abs(num)>0;if(!enabled)continue;var effect=new JsonObject{{"type",type},{"enabled",true}};var pars=new JsonObject();if(value.ValueKind==JsonValueKind.Number){var key=type is "blur" or "sharpen"?"amount":type is "hue"?"degrees":"value";pars[key]=value.GetDouble();}else if(value.ValueKind==JsonValueKind.Object)pars=JsonNode.Parse(value.GetRawText()) as JsonObject??new JsonObject();effect["params"]=pars;combined.Add(effect);}var trackFx=GetLegacyTrackEffects(root,sequenceId,trackId,trackName);if(trackFx.ValueKind==JsonValueKind.Array)foreach(var fx in trackFx.EnumerateArray())combined.Add(JsonNode.Parse(fx.GetRawText()));return combined.ToJsonString();}
    private static JsonElement FindLegacyTimeline(JsonElement root,string sequenceId){
        if(!root.TryGetProperty("legacyPayload",out var payload)||payload.ValueKind!=JsonValueKind.Object)return default;
        if(payload.TryGetProperty("tl",out var tl)&&tl.ValueKind==JsonValueKind.Object&&(sequenceId=="root"||S(tl,"id")==sequenceId))return tl;
        if(payload.TryGetProperty("sequences",out var sequences)&&sequences.ValueKind==JsonValueKind.Object){if(sequences.TryGetProperty(sequenceId,out var byId)&&byId.ValueKind==JsonValueKind.Object)return byId;foreach(var item in sequences.EnumerateObject())if(S(item.Value,"id")==sequenceId)return item.Value;}
        if(S(payload,"id")==sequenceId||!payload.TryGetProperty("sequences",out _))return payload;
        return default;
    }
    private static JsonElement GetLegacyTrackEffects(JsonElement root,string sequenceId,string trackId,string trackName){var timeline=FindLegacyTimeline(root,sequenceId);if(timeline.ValueKind!=JsonValueKind.Object||!timeline.TryGetProperty("trackState",out var state)||state.ValueKind!=JsonValueKind.Object)return default;var match=Regex.Match(trackId,@"-(?:video|audio|title)-(\d+)$");if(!match.Success)match=Regex.Match(trackName,@"\d+");if(!match.Success)return default;var key=match.Groups.Count>1?match.Groups[1].Value:match.Value;if(!state.TryGetProperty(key,out var trackState)||trackState.ValueKind!=JsonValueKind.Object||!trackState.TryGetProperty("effects",out var effects)||effects.ValueKind!=JsonValueKind.Array)return default;return effects;}
    private static JsonElement GetLegacyMasterEffects(JsonElement root,string sequenceId){var timeline=FindLegacyTimeline(root,sequenceId);if(timeline.ValueKind==JsonValueKind.Object&&timeline.TryGetProperty("masterEffects",out var fx)&&fx.ValueKind==JsonValueKind.Array)return fx;if(timeline.ValueKind==JsonValueKind.Object&&timeline.TryGetProperty("settings",out var timelineSettings)&&timelineSettings.ValueKind==JsonValueKind.Object&&timelineSettings.TryGetProperty("masterEffects",out fx)&&fx.ValueKind==JsonValueKind.Array)return fx;if(root.TryGetProperty("settings",out var settings)&&settings.ValueKind==JsonValueKind.Object&&settings.TryGetProperty("masterEffects",out fx)&&fx.ValueKind==JsonValueKind.Array)return fx;return default;}
    public static bool HasLegacyMasterEffects(JsonElement root,string sequenceId){var effects=GetLegacyMasterEffects(root,sequenceId);return effects.ValueKind==JsonValueKind.Array&&effects.GetArrayLength()>0;}
    private static void AppendEffects(List<string> filters,JsonElement effects,string timeExpr,string owner,JsonElement legacyFields=default){if(effects.ValueKind!=JsonValueKind.Array)return;foreach(var effect in effects.EnumerateArray()){if(!B(effect,"enabled",true))continue;var type=S(effect,"type",S(effect,"name")).ToLowerInvariant();var pars=effect.TryGetProperty("parameters",out var p)?p:effect.TryGetProperty("params",out p)?p:effect;var keyframeEffect=FindLegacyEffectKeyframes(legacyFields,effect);double P(string name,double fallback)=>D(pars,name,fallback);string E(string name,double fallback,double min,double max)=>EffectExpression(keyframeEffect.ValueKind==JsonValueKind.Object?keyframeEffect:effect,name,P(name,fallback),timeExpr,min,max);switch(type){case "brightness":filters.Add($"eq=brightness='{E("value",0,-1,1)}'");break;case "contrast":filters.Add($"eq=contrast='{E("value",1,0,3)}'");break;case "saturation":filters.Add($"eq=saturation='{E("value",1,0,3)}'");break;case "color":case "colour":filters.Add($"eq=brightness='{E("brightness",0,-1,1)}':contrast='{E("contrast",1,0,3)}':saturation='{E("saturation",1,0,3)}'");break;case "gamma":filters.Add($"eq=gamma='{E("value",1,.1,10)}'");break;case "blur":filters.Add($"gblur=sigma='{E("amount",2,0,50)}'");break;case "sharpen":filters.Add($"unsharp=5:5:'{E("amount",.5,0,5)}'");break;case "grayscale":filters.Add("hue=s=0");break;case "sepia":filters.Add("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");break;case "invert":filters.Add("negate");break;case "vignette":filters.Add("vignette");break;case "flip-h":case "fliph":filters.Add("hflip");break;case "flip-v":case "flipv":filters.Add("vflip");break;case "hue":filters.Add($"hue=h='{E("degrees",0,-180,180)}'");break;case "exposure":filters.Add($"exposure='{E("value",0,-10,10)}'");break;case "temperature":filters.Add($"colortemperature=temperature='{E("kelvin",6500,1000,40000)}'");break;case "noise":filters.Add($"noise=alls='{E("amount",8,0,100)}':allf=t+u");break;case "posterize":filters.Add($"lutrgb=r='floor(val*{N(Math.Clamp(P("levels",6),2,32))}/255)*255/{N(Math.Clamp(P("levels",6),2,32))}':g='floor(val*{N(Math.Clamp(P("levels",6),2,32))}/255)*255/{N(Math.Clamp(P("levels",6),2,32))}':b='floor(val*{N(Math.Clamp(P("levels",6),2,32))}/255)*255/{N(Math.Clamp(P("levels",6),2,32))}'");break;case "pixelate":filters.Add($"scale=w='max(2,trunc(iw/{N(Math.Clamp(P("size",12),2,128))}))':h='max(2,trunc(ih/{N(Math.Clamp(P("size",12),2,128))}))',scale=iw:ih:flags=neighbor");break;case "vintage":filters.Add("curves=preset=vintage");break;default:throw new InvalidOperationException($"Export stopped: effect '{type}' on {owner} is not implemented by the native renderer. Disable or replace it instead of exporting an incorrect result.");}}}
    private static void AppendLegacyFx(List<string> filters,JsonElement legacy,string owner){if(legacy.ValueKind!=JsonValueKind.Object||!legacy.TryGetProperty("fx",out var fx)||fx.ValueKind!=JsonValueKind.Object)return;foreach(var prop in fx.EnumerateObject()){var name=prop.Name.ToLowerInvariant();var value=prop.Value;double n=value.ValueKind==JsonValueKind.Number&&value.TryGetDouble(out var v)?v:value.ValueKind==JsonValueKind.Object?D(value,"value",0):0;bool enabled=value.ValueKind==JsonValueKind.True||value.ValueKind==JsonValueKind.Object||value.ValueKind==JsonValueKind.Number&&Math.Abs(n)>0;if(!enabled)continue;switch(name){case "brightness":filters.Add($"eq=brightness={N(Math.Clamp(n,-1,1))}");break;case "contrast":filters.Add($"eq=contrast={N(Math.Clamp(n,0,3))}");break;case "saturation":filters.Add($"eq=saturation={N(Math.Clamp(n,0,3))}");break;case "gamma":filters.Add($"eq=gamma={N(Math.Clamp(n,.1,10))}");break;case "blur":filters.Add($"gblur=sigma={N(Math.Clamp(n,0,50))}");break;case "sharpen":filters.Add($"unsharp=5:5:{N(Math.Clamp(n,0,5))}");break;case "grayscale":filters.Add("hue=s=0");break;case "sepia":filters.Add("colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131");break;case "invert":filters.Add("negate");break;case "vignette":filters.Add("vignette");break;case "fliph":filters.Add("hflip");break;case "flipv":filters.Add("vflip");break;default:throw new InvalidOperationException($"Export stopped: legacy effect '{name}' on {owner} is not implemented.");}}}
    private static bool HasKeyframes(JsonElement keys, params string[] properties) => keys.ValueKind==JsonValueKind.Array && keys.EnumerateArray().Any(k=>properties.Any(p=>KeyPropertyMatches(S(k,"property"),p)));
    private static bool KeyPropertyMatches(string actual,string requested){actual=actual.ToLowerInvariant();requested=requested.ToLowerInvariant();if(actual==requested)return true;if(requested=="opacity"&&actual=="alpha")return true;if(requested=="x"&&(actual=="positionx"||actual=="transformx"))return true;if(requested=="y"&&(actual=="positiony"||actual=="transformy"))return true;if((requested=="scalex"||requested=="scaley")&&actual=="scale")return true;if(requested=="shearx"&&actual=="skewx")return true;if(requested=="sheary"&&actual=="skewy")return true;return false;}
    private static string KeyframeExpression(JsonElement keys,string property,double fallback,string timeExpr) {
        if(keys.ValueKind!=JsonValueKind.Array)return N(fallback);
        var points=keys.EnumerateArray().Where(k=>KeyPropertyMatches(S(k,"property"),property)).Select(k=>(Time:D(k,"time",D(k,"t")),Value:D(k,"value",D(k,"v")),Interpolation:S(k,"interpolation","linear"))).Where(k=>double.IsFinite(k.Time)&&double.IsFinite(k.Value)).OrderBy(k=>k.Time).ToList();
        if(points.Count==0)return N(fallback); string expr=N(points[^1].Value);
        for(int i=points.Count-2;i>=0;i--){var a=points[i];var b=points[i+1];var span=Math.Max(0.000001,b.Time-a.Time);var u=$"(({timeExpr}-{N(a.Time)})/{N(span)})";var interp=a.Interpolation.Equals("hold",StringComparison.OrdinalIgnoreCase)||a.Interpolation.Equals("step",StringComparison.OrdinalIgnoreCase)||a.Interpolation.Equals("constant",StringComparison.OrdinalIgnoreCase)?N(a.Value):a.Interpolation.Equals("bezier",StringComparison.OrdinalIgnoreCase)?$"({N(a.Value)}+({N(b.Value-a.Value)})*({u})*({u})*(3-2*({u})))":$"({N(a.Value)}+({N(b.Value-a.Value)})*{u})";var value=interp;expr=$"if(lt({timeExpr},{N(b.Time)}),{value},{expr})";}
        return $"if(lt({timeExpr},{N(points[0].Time)}),{N(points[0].Value)},{expr})";
    }
    private static string EffectExpression(JsonElement effect,string property,double fallback,string timeExpr,double min,double max){
        var points=new List<(double T,double V,string I)>();if(effect.TryGetProperty("keyframes",out var keyframes)&&keyframes.ValueKind==JsonValueKind.Object&&keyframes.TryGetProperty(property,out var array)&&array.ValueKind==JsonValueKind.Array)foreach(var k in array.EnumerateArray()){var t=D(k,"t",D(k,"time",double.NaN));var v=D(k,"v",D(k,"value",double.NaN));if(double.IsFinite(t)&&double.IsFinite(v))points.Add((t,Math.Clamp(v,min,max),S(k,"interpolation","linear")));}
        points=points.OrderBy(p=>p.T).ToList();if(points.Count==0)return N(Math.Clamp(fallback,min,max));string expr=N(points[^1].V);for(int i=points.Count-2;i>=0;i--){var a=points[i];var b=points[i+1];var span=Math.Max(.000001,b.T-a.T);var u=$"(({timeExpr}-{N(a.T)})/{N(span)})";var value=a.I is "hold" or "step" or "constant"?N(a.V):a.I=="bezier"?$"({N(a.V)}+({N(b.V-a.V)})*({u})*({u})*(3-2*({u})))":$"({N(a.V)}+({N(b.V-a.V)})*{u})";expr=$"if(lt({timeExpr},{N(b.T)}),{value},{expr})";}expr=$"if(lt({timeExpr},{N(points[0].T)}),{N(points[0].V)},{expr})";return $"max({N(min)},min({N(max)},{expr}))";
    }
    private static string AssTime(double seconds){seconds=Math.Max(0,seconds);int h=(int)(seconds/3600),m=(int)(seconds/60)%60;double sec=seconds%60;return $"{h}:{m:00}:{sec.ToString("00.00",CultureInfo.InvariantCulture)}";}
    private static string AssColor(string value,double opacity){var hex=value.Trim().TrimStart('#');if(hex.Length!=6)hex="FFFFFF";int alpha=(int)Math.Round(255*(1-Math.Clamp(opacity,0,1)));return $"&H{alpha:X2}{hex[4..6]}{hex[2..4]}{hex[0..2]}";}

    private static bool TryGetEnabledBezierMask(JsonElement element, out JsonObject? mask)
    {
        mask = BezierMaskModel.FromElement(element);
        if (mask is null) return false;
        if (mask["enabled"] is not null && bool.TryParse(mask["enabled"]!.ToString(), out var enabled) && !enabled) return false;
        return string.Equals(mask["shape"]?.ToString(), "bezier", StringComparison.OrdinalIgnoreCase);
    }

    private static string Atempo(double rate) { var parts=new List<string>(); while(rate>2){parts.Add("atempo=2");rate/=2;} while(rate<.5){parts.Add("atempo=0.5");rate/=.5;} parts.Add("atempo="+N(rate)); return string.Join(",",parts); }
    public static double ProbeDurationSeconds(string path)=>ProbeDuration(path);
    private static double ProbeDuration(string path) {
        try { if(!MediaToolPaths.HasFfprobe)return 0; var psi=new ProcessStartInfo{FileName=MediaToolPaths.Ffprobe,UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true}; foreach(var a in new[]{"-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",path})psi.ArgumentList.Add(a); using var p=Process.Start(psi); if(p is null)return 0; var output=p.StandardOutput.ReadToEnd(); _=p.StandardError.ReadToEnd(); return p.WaitForExit(5000)&&p.ExitCode==0&&double.TryParse(output,NumberStyles.Float,CultureInfo.InvariantCulture,out var d)&&double.IsFinite(d)?d:0; } catch{return 0;}
    }
    private static bool ProbeHasAudio(string path) {
        try {
            if (MediaToolPaths.HasFfprobe) {
                var psi=new ProcessStartInfo{FileName=MediaToolPaths.Ffprobe,UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};
                foreach(var a in new[]{"-v","error","-select_streams","a:0","-show_entries","stream=codec_type","-of","csv=p=0",path}) psi.ArgumentList.Add(a);
                using var p=Process.Start(psi); if(p is null)return false; var output=p.StandardOutput.ReadToEnd(); _=p.StandardError.ReadToEnd(); return p.WaitForExit(3000)&&p.ExitCode==0&&!string.IsNullOrWhiteSpace(output);
            }
            var fallback = new ProcessStartInfo{FileName=MediaToolPaths.Ffmpeg,UseShellExecute=false,RedirectStandardOutput=true,RedirectStandardError=true,CreateNoWindow=true};
            foreach(var a in new[]{"-hide_banner","-i",path,"-t","0.01","-f","null","-"}) fallback.ArgumentList.Add(a);
            using var probe=Process.Start(fallback); if(probe is null)return false; var stderr=probe.StandardError.ReadToEnd(); var stdout=probe.StandardOutput.ReadToEnd(); _=probe.WaitForExit(4000); return stderr.Contains(" Audio:",StringComparison.OrdinalIgnoreCase);
        } catch { return false; }
    }

    public static JsonArray NormalizeAiOperations(JsonElement operations, JsonElement projectRoot, out List<string> descriptions)
    {
        if (operations.ValueKind != JsonValueKind.Array || operations.GetArrayLength() == 0)
            throw new InvalidOperationException("The AI plan must contain at least one operation.");
        if (operations.GetArrayLength() > 80)
            throw new InvalidOperationException("The AI plan has more than 80 operations; ask for a smaller, more focused edit.");
        var activeId = S(projectRoot, "activeSequenceId");
        var sequences = projectRoot.GetProperty("sequences").EnumerateArray().ToList();
        var sequence = sequences.FirstOrDefault(x => S(x, "id") == activeId);
        if (sequence.ValueKind != JsonValueKind.Object) sequence = sequences.FirstOrDefault();
        if (sequence.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("The project has no editable sequence.");
        var clips = sequence.GetProperty("clips").EnumerateArray().ToDictionary(x => S(x, "id"), x => x, StringComparer.Ordinal);
        var tracks = sequence.GetProperty("tracks").EnumerateArray().ToDictionary(x => S(x, "id"), x => x, StringComparer.Ordinal);
        var plannedTrackTypes = new Dictionary<string, string>(StringComparer.Ordinal);
        var assets = projectRoot.GetProperty("assets").EnumerateArray().ToDictionary(x => S(x, "id"), x => x, StringComparer.Ordinal);
        var transitions = sequence.TryGetProperty("transitions", out var transitionArray) && transitionArray.ValueKind == JsonValueKind.Array
            ? transitionArray.EnumerateArray().ToDictionary(x => S(x, "id"), x => x, StringComparer.Ordinal)
            : new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var batch = new JsonArray(); descriptions = new List<string>();

        static string RequiredString(JsonElement value, string name)
        {
            var text = S(value, name);
            if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException($"Operation requires '{name}'.");
            return text;
        }
        static double RequiredNumber(JsonElement value, string name)
        {
            if (!value.TryGetProperty(name, out var node) || !node.TryGetDouble(out var number) || !double.IsFinite(number))
                throw new InvalidOperationException($"Operation requires a finite numeric '{name}'.");
            return number;
        }
        static bool RequiredBoolean(JsonElement value, string name)
        {
            if (!value.TryGetProperty(name, out var node) || node.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new InvalidOperationException($"Operation requires a boolean '{name}'.");
            return node.GetBoolean();
        }
        static JsonNode? CloneValue(JsonElement value, string name)
        {
            if (!value.TryGetProperty(name, out var node)) throw new InvalidOperationException($"Operation requires '{name}'.");
            return JsonNode.Parse(node.GetRawText());
        }
        static JsonObject PropertyEdit(string clipId, string property, JsonNode? value) => new()
        { ["op"] = "property", ["clipId"] = clipId, ["property"] = property, ["value"] = value?.DeepClone() };
        static void RequireRange(double value, double min, double max, string label)
        { if (!double.IsFinite(value) || value < min || value > max) throw new InvalidOperationException($"{label} must be between {min} and {max}."); }
        void RequireClip(string id) { if (!clips.ContainsKey(id)) throw new InvalidOperationException($"The plan references unknown clip ID '{id}'."); }
        void RequireTrack(string id) { if (!tracks.ContainsKey(id) && !plannedTrackTypes.ContainsKey(id)) throw new InvalidOperationException($"The plan references unknown track ID '{id}'."); }
        void RequireAsset(string id) { if (!assets.ContainsKey(id)) throw new InvalidOperationException($"The plan references unknown asset ID '{id}'."); if (B(assets[id], "missing")) throw new InvalidOperationException($"Asset '{id}' is marked missing and cannot be added."); }

        foreach (var op in operations.EnumerateArray())
        {
            var kind = RequiredString(op, "op");
            var label = kind;
            switch (kind)
            {
                case "add_track":
                {
                    var type = S(op, "type", "video").ToLowerInvariant();
                    if (type is not ("video" or "audio")) throw new InvalidOperationException("New track type must be video or audio.");
                    var name = S(op, "name", type == "audio" ? "AI Audio Track" : "AI Video Track").Trim();
                    if (name.Length == 0 || name.Length > 120) throw new InvalidOperationException("New track name must contain 1–120 characters.");
                    var id = S(op, "track_id");
                    if (string.IsNullOrWhiteSpace(id)) id = "ai-track-" + Guid.NewGuid().ToString("N");
                    if (tracks.ContainsKey(id) || plannedTrackTypes.ContainsKey(id)) throw new InvalidOperationException($"Track ID '{id}' already exists.");
                    plannedTrackTypes.Add(id, type);
                    batch.Add(new JsonObject { ["op"]="add_track", ["trackId"]=id, ["name"]=name, ["type"]=type });
                    label += $" · {type} track '{name}'"; break;
                }
                case "move_clip":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var start = RequiredNumber(op, "start"); RequireRange(start, 0, 1e9, "Timeline start");
                    var row = new JsonObject { ["op"] = "move", ["clipId"] = id, ["start"] = start };
                    if (op.TryGetProperty("track_id", out var trackNode) && trackNode.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(trackNode.GetString())) { var trackId = trackNode.GetString()!; RequireTrack(trackId); row["trackId"] = trackId; }
                    batch.Add(row); label += $" · {id} → {start:0.###}s"; break;
                }
                case "trim_clip":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var sourceIn = RequiredNumber(op, "source_in"); var sourceOut = RequiredNumber(op, "source_out");
                    if (sourceIn < 0 || sourceOut <= sourceIn) throw new InvalidOperationException("Trim source_out must be greater than non-negative source_in.");
                    var assetId = S(clips[id], "assetId"); if (assets.TryGetValue(assetId, out var asset) && D(asset, "duration") > 0 && sourceOut > D(asset, "duration") + 0.000001) throw new InvalidOperationException($"Trim for clip '{id}' exceeds its source duration.");
                    batch.Add(new JsonObject { ["op"] = "range", ["clipId"] = id, ["sourceIn"] = sourceIn, ["sourceOut"] = sourceOut }); label += $" · {id} trim"; break;
                }
                case "set_volume":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var value = RequiredNumber(op, "volume"); RequireRange(value, 0, 4, "Volume");
                    batch.Add(new JsonObject { ["op"] = "volume", ["clipId"] = id, ["value"] = value }); label += $" · {id} volume {value:0.##}"; break;
                }
                case "set_speed":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var value = RequiredNumber(op, "speed"); RequireRange(value, .05, 16, "Playback speed");
                    batch.Add(PropertyEdit(id, "playbackRate", JsonValue.Create(value))); label += $" · {id} speed {value:0.##}×"; break;
                }
                case "set_opacity":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var value = RequiredNumber(op, "opacity"); RequireRange(value, 0, 1, "Opacity");
                    batch.Add(PropertyEdit(id, "opacity", JsonValue.Create(value))); label += $" · {id} opacity {value:0.##}"; break;
                }
                case "set_enabled":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var value = RequiredBoolean(op, "enabled");
                    batch.Add(PropertyEdit(id, "enabled", JsonValue.Create(value))); label += $" · {id} {(value ? "enable" : "disable")}"; break;
                }
                case "rename_clip":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var name = RequiredString(op, "name");
                    batch.Add(PropertyEdit(id, "name", JsonValue.Create(name))); label += $" · {id} rename"; break;
                }
                case "set_transform":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id);
                    if (!op.TryGetProperty("transform", out var transform) || transform.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("set_transform requires a transform object.");
                    var propertyMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["x"]="transform.x",["y"]="transform.y",["scaleX"]="transform.scaleX",["scaleY"]="transform.scaleY",["rotation"]="transform.rotation",["shearX"]="transform.shearX",["shearY"]="transform.shearY" };
                    var properties = transform.EnumerateObject().ToDictionary(x => x.Name, x => x.Value, StringComparer.OrdinalIgnoreCase);
                    if (properties.TryGetValue("scale", out var scaleNode)) { if (!scaleNode.TryGetDouble(out var scale) || !double.IsFinite(scale)) throw new InvalidOperationException("Transform scale must be numeric."); RequireRange(scale,.05,8,"Scale"); properties.TryAdd("scaleX", JsonDocument.Parse(scale.ToString(CultureInfo.InvariantCulture)).RootElement.Clone()); properties.TryAdd("scaleY", JsonDocument.Parse(scale.ToString(CultureInfo.InvariantCulture)).RootElement.Clone()); }
                    foreach (var item in properties)
                    {
                        if (!propertyMap.TryGetValue(item.Key, out var property)) { if (item.Key.Equals("scale", StringComparison.OrdinalIgnoreCase)) continue; throw new InvalidOperationException($"Unsupported transform property '{item.Key}'."); }
                        if (!item.Value.TryGetDouble(out var value) || !double.IsFinite(value)) throw new InvalidOperationException($"Transform '{item.Key}' must be a finite number.");
                        if (item.Key.Equals("x",StringComparison.OrdinalIgnoreCase)||item.Key.Equals("y",StringComparison.OrdinalIgnoreCase)) RequireRange(value,-4,4,item.Key);
                        else if (item.Key.Equals("scaleX",StringComparison.OrdinalIgnoreCase)||item.Key.Equals("scaleY",StringComparison.OrdinalIgnoreCase)) RequireRange(value,.05,8,item.Key);
                        else if (item.Key.Equals("rotation",StringComparison.OrdinalIgnoreCase)) RequireRange(value,-3600,3600,item.Key);
                        else if (item.Key.StartsWith("shear",StringComparison.OrdinalIgnoreCase)) RequireRange(value,-2,2,item.Key);
                        batch.Add(PropertyEdit(id, property, JsonValue.Create(value)));
                    }
                    label += $" · {id} transform"; break;
                }
                case "set_keyframe":
                {
                    var id = RequiredString(op, "clip_id"); RequireClip(id); var property = RequiredString(op, "property"); var time = RequiredNumber(op, "time"); var value = RequiredNumber(op, "value"); var interpolation = S(op,"interpolation","linear");
                    var validProperties = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {"x","y","positionX","positionY","scale","scaleX","scaleY","rotation","opacity","alpha","shearX","shearY","volume","playbackRate"};
                    if (!validProperties.Contains(property)) throw new InvalidOperationException($"Unsupported keyframe property '{property}'.");
                    if (time < 0 || time > Math.Max(.001, (D(clips[id],"sourceOut")-D(clips[id],"sourceIn"))/Math.Max(.05,D(clips[id],"playbackRate",1))) + .001) throw new InvalidOperationException("Keyframe time must fall within the clip duration.");
                    if (interpolation is not ("linear" or "bezier" or "constant")) throw new InvalidOperationException("Keyframe interpolation must be linear, bezier or constant.");
                    batch.Add(new JsonObject { ["op"]="keyframe",["clipId"]=id,["property"]=property,["time"]=time,["value"]=value,["interpolation"]=interpolation }); label += $" · {id} keyframe {property}@{time:0.###}s"; break;
                }
                case "set_mask":
                {
                    var id=RequiredString(op,"clip_id");RequireClip(id);
                    if(!op.TryGetProperty("mask",out var mask)||mask.ValueKind!=JsonValueKind.Object)throw new InvalidOperationException("set_mask requires a mask object.");
                    var shape=S(mask,"shape").ToLowerInvariant();if(shape is not ("rectangle" or "ellipse" or "path" or "bezier"))throw new InvalidOperationException("Mask shape must be rectangle, ellipse, path or bezier.");
                    batch.Add(new JsonObject { ["op"]="mask",["clipId"]=id,["mask"]=JsonNode.Parse(mask.GetRawText()) });label += $" · {id} {shape} mask";break;
                }
                case "set_effect":
                {
                    var id = RequiredString(op,"clip_id"); RequireClip(id); var type=RequiredString(op,"type").ToLowerInvariant(); var parameter=RequiredString(op,"parameter"); var value=RequiredNumber(op,"value");
                    var ranges = type switch { "brightness" => (Parameter:"value",Min:-1d,Max:1d), "contrast" or "saturation" => (Parameter:"value",Min:0d,Max:3d), "gamma" => (Parameter:"value",Min:.1d,Max:10d), "blur" => (Parameter:"amount",Min:0d,Max:50d), "sharpen" => (Parameter:"amount",Min:0d,Max:5d), _ => throw new InvalidOperationException($"Effect '{type}' is not in the native AI effect allowlist.") };
                    if (parameter != ranges.Parameter) throw new InvalidOperationException($"Effect '{type}' requires parameter '{ranges.Parameter}'."); RequireRange(value,ranges.Min,ranges.Max,$"{type} {parameter}");
                    batch.Add(new JsonObject { ["op"]="effect",["clipId"]=id,["type"]=type,["parameter"]=parameter,["value"]=value,["enabled"]=true }); label += $" · {id} {type}"; break;
                }
                case "clear_effects":
                {
                    var id=RequiredString(op,"clip_id");RequireClip(id);batch.Add(new JsonObject { ["op"]="clear_effects",["clipId"]=id });label += $" · {id} clear effects";break;
                }
                case "split_clip":
                {
                    var id=RequiredString(op,"clip_id");RequireClip(id);var time=RequiredNumber(op,"at");var start=D(clips[id],"timelineStart");var end=start+(D(clips[id],"sourceOut")-D(clips[id],"sourceIn"))/Math.Max(.05,D(clips[id],"playbackRate",1));
                    if(time<=start+.000001||time>=end-.000001)throw new InvalidOperationException($"Split time for '{id}' must be inside the current clip ({start:0.###}–{end:0.###}s).");
                    batch.Add(new JsonObject { ["op"]="split",["clipId"]=id,["start"]=time });label += $" · {id} split@{time:0.###}s";break;
                }
                case "delete_clip":
                {
                    var id=RequiredString(op,"clip_id");RequireClip(id);batch.Add(new JsonObject { ["op"]="remove",["clipId"]=id });label += $" · {id} delete";break;
                }
                case "set_track_state":
                {
                    var id=RequiredString(op,"track_id");RequireTrack(id);var property=RequiredString(op,"property");
                    if(property is not ("locked" or "muted" or "solo" or "visible" or "name" or "gain" or "opacity"))throw new InvalidOperationException($"Unsupported track property '{property}'.");
                    JsonNode? value;
                    if(property=="name") { var name=RequiredString(op,"value"); if(name.Length>120)throw new InvalidOperationException("Track name cannot exceed 120 characters."); value=JsonValue.Create(name); }
                    else if(property is "gain" or "opacity") { var number=RequiredNumber(op,"value"); RequireRange(number,0,property=="gain"?4:1,$"Track {property}"); value=JsonValue.Create(number); }
                    else value=JsonValue.Create(RequiredBoolean(op,"value"));
                    batch.Add(new JsonObject { ["op"]="track_state",["trackId"]=id,["property"]=property,["value"]=value });label += $" · track {id} {property}";break;
                }
                case "timeline_edit":
                {
                    var edit=RequiredString(op,"edit");if(edit is not ("ripple_delete" or "insert_gap"))throw new InvalidOperationException("Timeline edit must be ripple_delete or insert_gap.");var start=RequiredNumber(op,"start");var end=RequiredNumber(op,"end");RequireRange(start,0,1e9,"Timeline edit start");RequireRange(end,0,1e9,"Timeline edit end");if(end<=start)throw new InvalidOperationException("Timeline edit end must be after start.");
                    batch.Add(new JsonObject { ["op"]="timeline_edit",["editKind"]=edit,["start"]=start,["end"]=end });label += $" · {edit} {start:0.###}–{end:0.###}s";break;
                }
                case "add_clip":
                {
                    var assetId=RequiredString(op,"asset_id");RequireAsset(assetId);var trackId=RequiredString(op,"track_id");RequireTrack(trackId);var asset=assets[assetId];var mediaType=S(asset,"mediaType","video");var trackType=tracks.TryGetValue(trackId,out var track)?S(track,"type","video"):plannedTrackTypes.GetValueOrDefault(trackId,"video");
                    if ((mediaType=="audio")!=(trackType=="audio"))throw new InvalidOperationException("The selected asset's media type is incompatible with the requested track.");
                    var start=RequiredNumber(op,"start");var sourceIn=RequiredNumber(op,"source_in");var sourceOut=RequiredNumber(op,"source_out");RequireRange(start,0,1e9,"Added clip timeline start");if(sourceIn<0||sourceOut<=sourceIn||D(asset,"duration")>0&&sourceOut>D(asset,"duration")+.000001)throw new InvalidOperationException("Added clip has an invalid source range.");
                    batch.Add(new JsonObject { ["op"]="add_clip",["trackId"]=trackId,["assetId"]=assetId,["name"]=S(op,"name",S(asset,"name")),["start"]=start,["sourceIn"]=sourceIn,["sourceOut"]=sourceOut });label += $" · add {S(asset,"name",assetId)} at {start:0.###}s";break;
                }
                case "set_transition":
                {
                    var from=RequiredString(op,"from_clip_id");var to=RequiredString(op,"to_clip_id");RequireClip(from);RequireClip(to);if(from==to)throw new InvalidOperationException("A transition must connect two different clips.");
                    var type=RequiredString(op,"type").ToLowerInvariant();var types=new HashSet<string>(StringComparer.Ordinal){"crossfade","dissolve","fade","fadeblack","none","wipeleft","wiperight","wipeup","wipedown","slideleft","slideright","circleopen","radial","pixelize"};if(!types.Contains(type))throw new InvalidOperationException($"Unsupported transition type '{type}'.");
                    var start=RequiredNumber(op,"start");var duration=RequiredNumber(op,"duration");RequireRange(start,0,1e9,"Transition start");RequireRange(duration,.05,30,"Transition duration");var trackId=S(op,"track_id");if(trackId.Length>0)RequireTrack(trackId);
                    var transitionId=S(op,"transition_id");if(transitionId.Length>0&&!transitions.ContainsKey(transitionId))throw new InvalidOperationException($"Unknown transition ID '{transitionId}'. Provide an existing ID only when updating a transition.");if(transitionId.Length==0)transitionId="ai-transition-"+Guid.NewGuid().ToString("N");
                    batch.Add(new JsonObject { ["op"]="transition",["transitionId"]=transitionId,["type"]=type,["trackId"]=trackId,["fromClipId"]=from,["toClipId"]=to,["start"]=start,["duration"]=duration,["audio"]=B(op,"audio") });label += $" · {type} {from} → {to}";break;
                }
                case "remove_transition":
                {
                    var id=RequiredString(op,"transition_id");if(!transitions.ContainsKey(id))throw new InvalidOperationException($"Unknown transition ID '{id}'.");batch.Add(new JsonObject { ["op"]="remove_transition",["transitionId"]=id });label += $" · remove transition {id}";break;
                }
                default: throw new InvalidOperationException($"Unsupported native AI operation '{kind}'. No changes have been applied.");
            }
            descriptions.Add(label);
        }
        if(batch.Count==0)throw new InvalidOperationException("The AI plan did not contain any applicable operations.");
        return batch;
    }

    public static async Task<string> AskAiAsync(string apiKey,string model,string request,string projectJson,CancellationToken ct=default)
    {
        if(string.IsNullOrWhiteSpace(apiKey)) throw new InvalidOperationException("An OpenRouter API key is required. No key is bundled with Frosty.");
        using var http=new HttpClient{Timeout=TimeSpan.FromMinutes(2)}; http.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue("Bearer",apiKey);
        using var compact=JsonDocument.Parse(projectJson);var root=compact.RootElement;
        var assetSummary=root.GetProperty("assets").EnumerateArray().Select(a=>new {id=S(a,"id"),name=S(a,"name"),path=S(a,"path"),mediaType=S(a,"mediaType"),duration=D(a,"duration"),missing=B(a,"missing")}).ToArray();
        var sequenceSummary=root.GetProperty("sequences").EnumerateArray().Select(seq=>new {
            id=S(seq,"id"),name=S(seq,"name"),settings=Child(seq,"settings"),
            tracks=seq.GetProperty("tracks").EnumerateArray().Select(t=>new{id=S(t,"id"),name=S(t,"name"),type=S(t,"type"),order=I(t,"order"),locked=B(t,"locked"),muted=B(t,"muted"),solo=B(t,"solo"),visible=B(t,"visible",true),gain=D(t,"gain",1),opacity=D(t,"opacity",1)}).ToArray(),
            clips=seq.GetProperty("clips").EnumerateArray().Select(c=>new {
                id=S(c,"id"),name=S(c,"name"),assetId=S(c,"assetId"),trackId=S(c,"trackId"),mediaType=S(c,"mediaType"),timelineStart=D(c,"timelineStart"),sourceIn=D(c,"sourceIn"),sourceOut=D(c,"sourceOut"),playbackRate=D(c,"playbackRate",1),enabled=B(c,"enabled",true),volume=D(c,"volume",1),opacity=D(c,"opacity",1),nestedSequenceId=S(c,"nestedSequenceId"),effects=Child(c,"effects"),keyframes=Child(c,"keyframes"),legacyFields=SelectedLegacyFields(c)
            }).ToArray(),
            transitions=seq.TryGetProperty("transitions",out var tr)?tr.Clone():JsonSerializer.SerializeToElement(Array.Empty<object>()),
            markers=seq.TryGetProperty("markers",out var mk)?mk.Clone():JsonSerializer.SerializeToElement(Array.Empty<object>())
        }).ToArray();
        var summary=new {name=S(root,"name","Untitled"),activeSequenceId=S(root,"activeSequenceId"),settings=Child(root,"settings"),assets=assetSummary,sequences=sequenceSummary};
        var instructions="You are Frosty's native C++/WPF edit planner. Return valid JSON only with shape {\"summary\":\"one sentence\",\"ops\":[...]}. Plan only operations from this allowlist. Times are timeline seconds except keyframe time (clip-local seconds) and trim source_in/source_out (source seconds). Never invent clip, asset, or existing track/transition IDs; a new track may omit track_id so Frosty generates one. The WPF app validates and applies the full plan atomically, so any unsupported operation or invalid range rejects the entire batch. Use fewer, high-impact changes, preserve source media, and do not promise operations outside this list. Supported operations: " +
            "{\"op\":\"add_track\", optional \"track_id\":new unique ID, \"name\":string, \"type\":\"video|audio\"}; " +
            "{\"op\":\"move_clip\",\"clip_id\":\"id\",\"start\":seconds, optional \"track_id\":\"existing track ID\"}; " +
            "{\"op\":\"trim_clip\",\"clip_id\":\"id\",\"source_in\":seconds,\"source_out\":seconds}; " +
            "{\"op\":\"set_volume\",\"clip_id\":\"id\",\"volume\":0..4}; {\"op\":\"set_speed\",\"clip_id\":\"id\",\"speed\":0.05..16}; {\"op\":\"set_opacity\",\"clip_id\":\"id\",\"opacity\":0..1}; {\"op\":\"set_enabled\",\"clip_id\":\"id\",\"enabled\":true|false}; {\"op\":\"rename_clip\",\"clip_id\":\"id\",\"name\":\"new name\"}; " +
            "{\"op\":\"set_transform\",\"clip_id\":\"id\",\"transform\":{\"x\":number,\"y\":number,\"scaleX\":number,\"scaleY\":number,\"rotation\":degrees,\"shearX\":number,\"shearY\":number}} (only include properties to change); " +
            "{\"op\":\"set_keyframe\",\"clip_id\":\"id\",\"property\":\"x|y|positionX|positionY|scale|scaleX|scaleY|rotation|opacity|alpha|shearX|shearY|volume|playbackRate\",\"time\":clip-local seconds,\"value\":number,\"interpolation\":\"linear|bezier|constant\"}; " +
            "{\"op\":\"set_effect\",\"clip_id\":\"id\",\"type\":\"brightness|contrast|saturation|gamma|blur|sharpen\",\"parameter\":\"value\" or \"amount\",\"value\":number}; {\"op\":\"clear_effects\",\"clip_id\":\"id\"}; {\"op\":\"split_clip\",\"clip_id\":\"id\",\"at\":timeline seconds}; {\"op\":\"delete_clip\",\"clip_id\":\"id\"}; " +
            "{\"op\":\"set_track_state\",\"track_id\":\"id\",\"property\":\"locked|muted|solo|visible|name|gain|opacity\",\"value\":boolean, string or number}; " +
            "{\"op\":\"set_mask\",\"clip_id\":\"id\",\"mask\":{\"shape\":\"rectangle|ellipse|path|bezier\", mask-specific fields}}; {\"op\":\"timeline_edit\",\"edit\":\"ripple_delete|insert_gap\",\"start\":seconds,\"end\":seconds}; " +
            "{\"op\":\"add_clip\",\"asset_id\":\"existing asset id\",\"track_id\":\"existing track id\",\"start\":seconds,\"source_in\":seconds,\"source_out\":seconds, optional \"name\":string}; " +
            "{\"op\":\"set_transition\",\"from_clip_id\":\"existing clip id\",\"to_clip_id\":\"existing clip id\",\"type\":\"crossfade|dissolve|fade|fadeblack|none|wipeleft|wiperight|wipeup|wipedown|slideleft|slideright|circleopen|radial|pixelize\",\"start\":seconds,\"duration\":0.05..30, optional \"track_id\":existing track ID, optional \"audio\":boolean, optional \"transition_id\":existing ID for update}; {\"op\":\"remove_transition\",\"transition_id\":\"existing transition ID\"}. " +
            "Track creation is supported, including adding a track and then placing an existing asset on it in the same plan. Track deletion, sequence creation/deletion, text-overlay authoring, nested-sequence authoring, and web/download/image-generation tools are not implemented by this native planner. Do not invent clip, asset, or existing track IDs; for a new track, omit track_id and the app will generate one, or supply a unique new ID. Use existing asset IDs only. Respond with an ops array and a concise summary, no Markdown fences.";
        var body=JsonSerializer.Serialize(new{model,messages=new object[]{new{role="system",content=instructions},new{role="user",content="Request: "+request+"\nCurrent project and editable state JSON:\n"+JsonSerializer.Serialize(summary)}}},new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase});
        using var response=await http.PostAsync("https://openrouter.ai/api/v1/chat/completions",new StringContent(body,Encoding.UTF8,"application/json"),ct); var text=await response.Content.ReadAsStringAsync(ct); if(!response.IsSuccessStatusCode) throw new InvalidOperationException($"AI request failed ({(int)response.StatusCode}): {text}"); using var json=JsonDocument.Parse(text); return json.RootElement.GetProperty("choices")[0].GetProperty("message").GetString()??throw new InvalidOperationException("The AI model returned an empty response.");
    }
    private static JsonElement? Child(JsonElement element,string key)=>element.ValueKind==JsonValueKind.Object&&element.TryGetProperty(key,out var value)?value.Clone():null;
    private static JsonElement? SelectedLegacyFields(JsonElement clip)
    {
        if(!clip.TryGetProperty("legacyFields",out var legacy)||legacy.ValueKind!=JsonValueKind.Object)return null;
        var selected=new JsonObject();
        foreach(var key in new[]{"transform","fx","keyframes","mask","effects"})if(legacy.TryGetProperty(key,out var value))selected[key]=JsonNode.Parse(value.GetRawText());
        return JsonDocument.Parse(selected.ToJsonString()).RootElement.Clone();
    }
    private static string S(JsonElement e,string k,string fallback="")=>e.ValueKind==JsonValueKind.Object&&e.TryGetProperty(k,out var v)&&v.ValueKind!=JsonValueKind.Null?v.ToString():fallback;
    private static int I(JsonElement e,string k,int fallback=0)=>int.TryParse(S(e,k),out var n)?n:fallback;
    private static double D(JsonElement e,string k,double fallback=0)=>double.TryParse(S(e,k),NumberStyles.Float,CultureInfo.InvariantCulture,out var n)&&double.IsFinite(n)?n:fallback;
    private static bool B(JsonElement e,string k,bool fallback=false)=>e.ValueKind==JsonValueKind.Object&&e.TryGetProperty(k,out var v)&&(v.ValueKind is JsonValueKind.True or JsonValueKind.False)?v.GetBoolean():fallback;
}
