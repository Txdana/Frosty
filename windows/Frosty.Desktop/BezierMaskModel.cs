using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Frosty.Desktop;

/// <summary>Shared native-desktop Bézier path model for the editor, live preview and export matte renderer.</summary>
internal static class BezierMaskModel
{
    internal const int MaxAnchors = 12;
    internal readonly record struct Point(double X, double Y);
    internal readonly record struct Node(double X, double Y, Point In, Point Out);

    private static double Clamp01(double v) => Math.Clamp(double.IsFinite(v) ? v : 0.5, 0, 1);
    private static Point Mix(Point a, Point b, double t) => new(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t);
    private static double Number(JsonNode? n, double fallback = 0) => n is null || !double.TryParse(n.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) || !double.IsFinite(v) ? fallback : v;
    private static string String(JsonNode? n, string fallback = "") => n?.ToString() ?? fallback;
    private static bool Boolean(JsonNode? n, bool fallback = false) => bool.TryParse(n?.ToString(), out var v) ? v : fallback;

    public static JsonObject DefaultMask() => new()
    {
        ["enabled"] = true, ["shape"] = "bezier", ["invert"] = false, ["feather"] = 0,
        ["nodes"] = new JsonArray(
            MakeNode(.5,.12,.34,.12,.66,.12), MakeNode(.88,.5,.88,.29,.88,.71),
            MakeNode(.5,.88,.66,.88,.34,.88), MakeNode(.12,.5,.12,.71,.12,.29)),
        ["pathKeyframes"] = new JsonArray()
    };

    private static JsonObject MakeNode(double x,double y,double ix,double iy,double ox,double oy) => new()
    { ["x"] = x,["y"] = y,["in"] = new JsonObject { ["x"] = ix,["y"] = iy },["out"] = new JsonObject { ["x"] = ox,["y"] = oy } };
    private static JsonObject NodeJson(Node n) => new()
    { ["x"] = n.X,["y"] = n.Y,["in"] = new JsonObject { ["x"] = n.In.X,["y"] = n.In.Y },["out"] = new JsonObject { ["x"] = n.Out.X,["y"] = n.Out.Y } };
    private static JsonArray NodesJson(IEnumerable<Node> nodes) { var a = new JsonArray(); foreach (var n in nodes) a.Add(NodeJson(n)); return a; }
    public static JsonArray ToJsonArray(IEnumerable<Node> nodes) => NodesJson(nodes);

    public static List<Node> ReadNodes(JsonNode? raw)
    {
        if (raw is not JsonArray a || a.Count < 3 || a.Count > MaxAnchors) return ReadNodes(DefaultMask()["nodes"]);
        var result = new List<Node>(a.Count);
        foreach (var n in a)
        {
            var x = Clamp01(Number(n?["x"], .5)); var y = Clamp01(Number(n?["y"], .5));
            result.Add(new Node(x,y,new Point(Clamp01(Number(n?["in"]?["x"],x)),Clamp01(Number(n?["in"]?["y"],y))),new Point(Clamp01(Number(n?["out"]?["x"],x)),Clamp01(Number(n?["out"]?["y"],y)))));
        }
        return result;
    }
    public static List<Node> Evaluate(JsonObject mask, double time)
    {
        var baseNodes = ReadNodes(mask["nodes"]);
        var keys = (mask["pathKeyframes"] as JsonArray)?.OfType<JsonObject>()
            .Select(k => new { T = Number(k["t"], -1), Nodes = ReadNodes(k["nodes"]), Interpolation = String(k["interpolation"], "linear") })
            .Where(k => k.T >= 0 && k.Nodes.Count == baseNodes.Count).OrderBy(k => k.T).ToList();
        if (keys is null || keys.Count == 0) return baseNodes;
        if (time <= keys[0].T) return keys[0].Nodes;
        if (time >= keys[^1].T) return keys[^1].Nodes;
        var i = 0; while (i < keys.Count - 1 && time > keys[i + 1].T) i++;
        var a = keys[i]; var b = keys[i + 1]; var t = Math.Clamp((time-a.T)/Math.Max(1e-9,b.T-a.T),0,1);
        if (a.Interpolation == "constant") t=0; else if (a.Interpolation == "bezier") t=t*t*(3-2*t);
        return a.Nodes.Select((n,index)=>{var q=b.Nodes[index]; return new Node(n.X+(q.X-n.X)*t,n.Y+(q.Y-n.Y)*t,Mix(n.In,q.In,t),Mix(n.Out,q.Out,t));}).ToList();
    }
    public static void SetAtTime(JsonObject mask, IEnumerable<Node> nodes, double time, string interpolation)
    {
        var array=NodesJson(nodes); var keys=mask["pathKeyframes"] as JsonArray;
        if(keys is null || keys.Count==0) { mask["nodes"] = array; return; }
        var t=Math.Max(0,time); var existing=keys.OfType<JsonObject>().FirstOrDefault(k=>Math.Abs(Number(k["t"],-100)-t)<1e-5);
        if(existing is null) { keys.Add(new JsonObject { ["t"]=t,["interpolation"]=ValidInterpolation(interpolation),["nodes"]=array }); }
        else { existing["nodes"]=array; existing["interpolation"]=ValidInterpolation(interpolation); }
        var ordered=keys.OfType<JsonObject>().OrderBy(k=>Number(k["t"])).Select(k=>(JsonNode)k.DeepClone()).ToList(); keys.Clear(); foreach(var k in ordered)keys.Add(k);
    }
    public static string ValidInterpolation(string value)=>value is "linear" or "bezier" or "constant"?value:"linear";
    public static void SplitSegmentEverywhere(JsonObject mask,int segment,double t=.5)
    {
        t=Math.Clamp(double.IsFinite(t)?t:.5,.001,.999);
        var baseNodes=ReadNodes(mask["nodes"]); if(baseNodes.Count>=MaxAnchors || segment<0 || segment>=baseNodes.Count)return;
        mask["nodes"]=NodesJson(Split(baseNodes,segment,t));
        if(mask["pathKeyframes"] is JsonArray keys) foreach(var k in keys.OfType<JsonObject>()) k["nodes"]=NodesJson(Split(ReadNodes(k["nodes"]),segment,t));
    }
    private static List<Node> Split(List<Node> nodes,int segment,double t)
    {
        var result=nodes.ToList(); var a=nodes[segment];var bi=(segment+1)%nodes.Count;var b=nodes[bi];
        var p0=new Point(a.X,a.Y);var p1=a.Out;var p2=b.In;var p3=new Point(b.X,b.Y);
        var q0=Mix(p0,p1,t);var q1=Mix(p1,p2,t);var q2=Mix(p2,p3,t);var r0=Mix(q0,q1,t);var r1=Mix(q1,q2,t);var s=Mix(r0,r1,t);
        result[segment]=a with { Out=q0 }; result[bi]=b with { In=q2 };
        result.Insert(segment+1,new Node(s.X,s.Y,r0,r1)); return result;
    }
    public static bool RemoveAnchorEverywhere(JsonObject mask,int index)
    {
        var baseNodes=ReadNodes(mask["nodes"]);if(baseNodes.Count<=3||index<0||index>=baseNodes.Count)return false;
        baseNodes.RemoveAt(index);mask["nodes"]=NodesJson(baseNodes);
        if(mask["pathKeyframes"] is JsonArray keys)foreach(var k in keys.OfType<JsonObject>()){var ns=ReadNodes(k["nodes"]);if(ns.Count>3&&index<ns.Count){ns.RemoveAt(index);k["nodes"]=NodesJson(ns);}}
        return true;
    }

    public static List<Point> Sample(List<Node> nodes,int stepsPerCurve=12)
    {
        var polygon=new List<Point>();var steps=Math.Clamp(stepsPerCurve,4,32);
        for(var i=0;i<nodes.Count;i++){var a=nodes[i];var b=nodes[(i+1)%nodes.Count];for(var s=0;s<steps;s++){var t=(double)s/steps;var u=1-t;double Cubic(double p0,double p1,double p2,double p3)=>u*u*u*p0+3*u*u*t*p1+3*u*t*t*p2+t*t*t*p3;polygon.Add(new Point(Clamp01(Cubic(a.X,a.Out.X,b.In.X,b.X)),Clamp01(Cubic(a.Y,a.Out.Y,b.In.Y,b.Y))));}}
        return polygon;
    }
    private static double DistanceToLine(Point p,Point a,Point b)
    {
        var dx=b.X-a.X;var dy=b.Y-a.Y;var length=Math.Sqrt(dx*dx+dy*dy);
        return length<1e-9?Math.Sqrt(Math.Pow(p.X-a.X,2)+Math.Pow(p.Y-a.Y,2)):Math.Abs(dy*p.X-dx*p.Y+b.X*a.Y-b.Y*a.X)/length;
    }
    private static void FlattenCubic(Point p0,Point p1,Point p2,Point p3,List<Point> output,int depth=0)
    {
        if(depth>=10||Math.Max(DistanceToLine(p1,p0,p3),DistanceToLine(p2,p0,p3))<=0.5){output.Add(p3);return;}
        var p01=Mix(p0,p1,.5);var p12=Mix(p1,p2,.5);var p23=Mix(p2,p3,.5);var p012=Mix(p01,p12,.5);var p123=Mix(p12,p23,.5);var mid=Mix(p012,p123,.5);
        FlattenCubic(p0,p01,p012,mid,output,depth+1);FlattenCubic(mid,p123,p23,p3,output,depth+1);
    }
    private static List<Point> SampleAdaptive(List<Node> nodes,int width,int height)
    {
        var polygon=new List<Point>(nodes.Count*8);
        for(var i=0;i<nodes.Count;i++)
        {
            var a=nodes[i];var b=nodes[(i+1)%nodes.Count];
            var p0=new Point(a.X*width,a.Y*height);var p1=new Point(a.Out.X*width,a.Out.Y*height);var p2=new Point(b.In.X*width,b.In.Y*height);var p3=new Point(b.X*width,b.Y*height);
            if(polygon.Count==0)polygon.Add(p0);FlattenCubic(p0,p1,p2,p3,polygon);
        }
        return polygon;
    }
    public static byte[] Rasterize(JsonObject mask,int width,int height,double time)
    {
        width=Math.Clamp(width,16,8192);height=Math.Clamp(height,16,8192);var polygon=SampleAdaptive(Evaluate(mask,time),width,height);var pixels=new byte[checked(width*height)];var minY=Math.Clamp((int)Math.Floor(polygon.Min(p=>p.Y)),0,height-1);var maxY=Math.Clamp((int)Math.Ceiling(polygon.Max(p=>p.Y))-1,0,height-1);var xs=new List<double>(polygon.Count);const int aaSamples=4;var diff=new double[width+1];var partial=new double[width];
        for(var y=minY;y<=maxY;y++)
        {
            Array.Clear(diff,0,diff.Length);Array.Clear(partial,0,partial.Length);
            for(var sub=0;sub<aaSamples;sub++)
            {
                xs.Clear();var py=y+(sub+.5)/aaSamples;
                for(var i=0;i<polygon.Count;i++){var a=polygon[i];var b=polygon[(i+1)%polygon.Count];if((a.Y<=py&&b.Y>py)||(b.Y<=py&&a.Y>py))xs.Add(a.X+(py-a.Y)*(b.X-a.X)/(b.Y-a.Y));}
                xs.Sort();
                for(var i=0;i+1<xs.Count;i+=2)
                {
                    var left=xs[i];var right=xs[i+1];if(right<=left||right<=0||left>=width)continue;left=Math.Max(0,left);right=Math.Min(width,right);
                    var x0=Math.Clamp((int)Math.Floor(left),0,width-1);var x1=Math.Clamp((int)Math.Floor(right),0,width);
                    if(x0==x1){partial[x0]+=right-left;continue;}
                    partial[x0]+=Math.Max(0,Math.Min(right,x0+1)-left);
                    if(x1<width)partial[x1]+=Math.Max(0,right-x1);
                    var fullStart=x0+1;var fullEnd=x1;if(fullEnd>fullStart){diff[fullStart]+=1;diff[fullEnd]-=1;}
                }
            }
            var coverage=0.0;var row=y*width;
            for(var x=0;x<width;x++){coverage+=diff[x];pixels[row+x]=(byte)Math.Clamp((int)Math.Round(Math.Clamp(coverage+partial[x],0,aaSamples)*255/aaSamples),0,255);}
        }
        var feather=Math.Clamp((int)Math.Round(Number(mask["feather"])),0,100);if(feather>0)pixels=BoxBlur(pixels,width,height,feather);
        if(Boolean(mask["invert"]))for(var i=0;i<pixels.Length;i++)pixels[i]=(byte)(255-pixels[i]);
        return pixels;
    }
    private static byte[] BoxBlur(byte[] src,int width,int height,int radius)
    {
        var tmp=new byte[src.Length];var dst=new byte[src.Length];
        for(var y=0;y<height;y++){var sum=0;for(var x=-radius;x<=radius;x++)if(x>=0&&x<width)sum+=src[y*width+x];for(var x=0;x<width;x++){tmp[y*width+x]=(byte)(sum/Math.Max(1,Math.Min(width-1,x+radius)-Math.Max(0,x-radius)+1));var leave=x-radius;var enter=x+radius+1;if(leave>=0)sum-=src[y*width+leave];if(enter<width)sum+=src[y*width+enter];}}
        for(var x=0;x<width;x++){var sum=0;for(var y=-radius;y<=radius;y++)if(y>=0&&y<height)sum+=tmp[y*width+x];for(var y=0;y<height;y++){dst[y*width+x]=(byte)(sum/Math.Max(1,Math.Min(height-1,y+radius)-Math.Max(0,y-radius)+1));var leave=y-radius;var enter=y+radius+1;if(leave>=0)sum-=tmp[leave*width+x];if(enter<height)sum+=tmp[enter*width+x];}}
        return dst;
    }
    public static void ApplyToBgra(byte[] frame,int width,int height,JsonObject mask,double localTime)
    {
        if(!Boolean(mask["enabled"],true)||String(mask["shape"])!="bezier"||frame.Length<width*height*4)return;
        ApplyMatteToBgra(frame,width,height,Rasterize(mask,width,height,localTime));
    }
    public static void ApplyMatteToBgra(byte[] frame,int width,int height,byte[] matte)
    {
        if(frame.Length<width*height*4||matte.Length<width*height)return;
        for(var i=0;i<width*height;i++){var a=i*4+3;frame[a]=(byte)((frame[a]*matte[i]+127)/255);}
    }
    public static bool HasAnimation(JsonObject mask)
    {
        var keys=mask["pathKeyframes"] as JsonArray;
        return keys is not null && keys.OfType<JsonObject>().Count(k=>Number(k["t"],-1)>=0)>1;
    }
    public static JsonObject? FromElement(JsonElement element)
    { try{return JsonNode.Parse(element.GetRawText()) as JsonObject;}catch{return null;} }

    public static async Task<string> CreateMatteVideoAsync(JsonObject mask,double fps,double duration,int width,int height,string workspace,string safeName,CancellationToken ct)
    {
        fps=Math.Clamp(fps,1,120);duration=Math.Max(1/fps,duration);
        if(!HasAnimation(mask))
        {
            ct.ThrowIfCancellationRequested();var staticPath=Path.Combine(workspace,"matte-"+safeName+".png");var pixels=Rasterize(mask,width,height,0);var bitmap=BitmapSource.Create(width,height,96,96,PixelFormats.Gray8,null,pixels,width);bitmap.Freeze();var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(var stream=File.Create(staticPath))encoder.Save(stream);return staticPath;
        }
        if(duration>7200+1e-6)throw new InvalidOperationException("Bézier mask matte is longer than the supported two-hour export limit.");
        var frames=Math.Max(1,(int)Math.Ceiling(duration*fps-1e-9));if(frames>864000)throw new InvalidOperationException("Bézier mask matte exceeds the supported two-hour frame limit.");
        var output=Path.Combine(workspace,"matte-"+safeName+".mkv");
        var psi=new ProcessStartInfo{FileName="ffmpeg",UseShellExecute=false,RedirectStandardInput=true,RedirectStandardError=true,RedirectStandardOutput=true,CreateNoWindow=true};
        foreach(var arg in new[]{"-y","-hide_banner","-loglevel","error","-f","rawvideo","-pixel_format","gray","-video_size",$"{width}x{height}","-framerate",fps.ToString("0.######",CultureInfo.InvariantCulture),"-i","pipe:0","-frames:v",frames.ToString(CultureInfo.InvariantCulture),"-an","-c:v","ffv1","-level","3","-pix_fmt","gray",output})psi.ArgumentList.Add(arg);
        using var p=Process.Start(psi)??throw new InvalidOperationException("Could not start FFmpeg to encode the Bézier mask matte.");
        var stderrTask=p.StandardError.ReadToEndAsync();var stdoutTask=p.StandardOutput.ReadToEndAsync();
        try
        {
            for(var frame=0;frame<frames;frame++)
            {
                ct.ThrowIfCancellationRequested();
                var pixels=Rasterize(mask,width,height,frame/fps);
                await p.StandardInput.BaseStream.WriteAsync(pixels.AsMemory(),ct);
            }
            p.StandardInput.Close();
            await p.WaitForExitAsync(ct);
        }
        catch
        {
            try{p.StandardInput.Close();}catch{}
            try{if(!p.HasExited)p.Kill(true);}catch{}
            try{await p.WaitForExitAsync(CancellationToken.None);}catch{}
            throw;
        }
        var err=await stderrTask;_=await stdoutTask;
        if(p.ExitCode!=0||!File.Exists(output)||new FileInfo(output).Length<128)throw new InvalidOperationException("Could not encode Bézier mask matte: "+err);
        return output;
    }
}
