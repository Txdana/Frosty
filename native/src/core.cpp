#include "frosty/core.hpp"
#include <boost/property_tree/json_parser.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <fstream>
#include <functional>
#include <iomanip>
#include <set>
#include <random>
#include <sstream>
#include <stdexcept>
#include <system_error>

namespace frosty { namespace {
using boost::property_tree::ptree;
std::string getS(const ptree& p,const std::string& k,const std::string& d=""){return p.get<std::string>(k,d);}
double getD(const ptree& p,const std::string& k,double d=0){return p.get<double>(k,d);}
int getI(const ptree& p,const std::string& k,int d=0){return p.get<int>(k,d);}
bool getB(const ptree& p,const std::string& k,bool d=false){return p.get<bool>(k,d);}

std::string jsonEscape(const std::string& s){std::ostringstream o;o<<'"';for(unsigned char c:s){switch(c){case '"':o<<"\\\"";break;case '\\':o<<"\\\\";break;case '\b':o<<"\\b";break;case '\f':o<<"\\f";break;case '\n':o<<"\\n";break;case '\r':o<<"\\r";break;case '\t':o<<"\\t";break;default:if(c<0x20){o<<"\\u"<<std::hex<<std::setw(4)<<std::setfill('0')<<static_cast<int>(c)<<std::dec;}else o<<static_cast<char>(c);}}o<<'"';return o.str();}
bool oneOf(const std::string& k,const std::set<std::string>& keys){return keys.find(k)!=keys.end();}
void emitJson(std::ostream& o,const ptree& p,const std::string& key="",int depth=0){
 static const std::set<std::string> arrays={"assets","media","sequences","tracks","clips","markers","groups","clipIds","transitions","nestedSequenceIds","keyframes","effects","nodes","pathKeyframes","video","layers","audio","text","fade"};
 static const std::set<std::string> objects={"settings","frameRate","parameters","legacyFields","legacyPayload","transform","keyframes","fx","trackState","music","trans","pos"};
 static const std::set<std::string> bools={"enabled","linkedAudio","muted","solo","visible","locked","missing","hasAudio","hasVideo","hasAudio","hasVideo","invert","has_audio","has_video","vfr","isImage","hasAlpha","audio"};
 static const std::set<std::string> numbers={"schemaVersion","width","height","numerator","denominator","fps","pixelAspectNumerator","pixelAspectDenominator","audioSampleRate","audioChannels","duration","timelineStart","sourceIn","sourceOut","playbackRate","start","in","out","speed","volume","opacity","gain","order","track","trackCount","time","t","value","feather","size","rotation","scale","scaleX","scaleY","shearX","shearY","x","y","alpha","zoom","brightness","contrast","saturation","blur","noiseDb","minDur","posX","posY","rate","widthPx","heightPx","startTime","endTime"};
 if(p.empty()){
  if(oneOf(key,arrays)){o<<"[]";return;}
  if(oneOf(key,objects)){o<<"{}";return;}
  const std::string value=p.data();
  if(oneOf(key,bools)&&(value=="true"||value=="false")){o<<value;return;}
  if(oneOf(key,numbers)&&!value.empty()){try{std::size_t used=0;double d=std::stod(value,&used);if(used==value.size()&&std::isfinite(d)){o<<std::setprecision(15)<<d;return;}}catch(...){}}
  o<<jsonEscape(value);return;
 }
 bool isArray=oneOf(key,arrays);if(isArray){o<<'[';bool first=true;for(const auto& item:p){if(!first)o<<',';first=false;o<<'\n'<<std::string((depth+1)*2,' ');emitJson(o,item.second,"",depth+1);}if(!first)o<<'\n'<<std::string(depth*2,' ');o<<']';return;}
 if(p.begin()->first.empty()){o<<'[';bool first=true;for(const auto& item:p){if(!first)o<<',';first=false;o<<'\n'<<std::string((depth+1)*2,' ');emitJson(o,item.second,"",depth+1);}if(!first)o<<'\n'<<std::string(depth*2,' ');o<<']';return;}
 o<<'{';bool first=true;for(const auto& item:p){if(!first)o<<',';first=false;o<<'\n'<<std::string((depth+1)*2,' ')<<jsonEscape(item.first)<<": ";emitJson(o,item.second,item.first,depth+1);}if(!first)o<<'\n'<<std::string(depth*2,' ');o<<'}';
}

ptree settingsTo(const ProjectSettings&s){ptree p;p.put("width",s.width);p.put("height",s.height);p.put("frameRate.numerator",s.frameRate.numerator);p.put("frameRate.denominator",s.frameRate.denominator);p.put("timebaseNumerator",s.timebaseNumerator);p.put("timebaseDenominator",s.timebaseDenominator);p.put("pixelAspectNumerator",s.pixelAspectNumerator);p.put("pixelAspectDenominator",s.pixelAspectDenominator);p.put("displayAspectNumerator",s.displayAspectNumerator);p.put("displayAspectDenominator",s.displayAspectDenominator);p.put("colorSpace",s.colorSpace);p.put("colorRange",s.colorRange);p.put("colorPrimaries",s.colorPrimaries);p.put("transferCharacteristics",s.transferCharacteristics);p.put("matrixCoefficients",s.matrixCoefficients);p.put("audioSampleRate",s.audioSampleRate);p.put("audioChannels",s.audioChannels);p.put("audioChannelLayout",s.audioChannelLayout);p.put("exportContainer",s.exportContainer);p.put("videoCodec",s.videoCodec);p.put("audioCodec",s.audioCodec);return p;}
ProjectSettings settingsFrom(const ptree&p){ProjectSettings s;s.width=getI(p,"width",1920);s.height=getI(p,"height",1080);s.frameRate.numerator=getI(p,"frameRate.numerator",getI(p,"fps",30));s.frameRate.denominator=getI(p,"frameRate.denominator",1);s.timebaseNumerator=getI(p,"timebaseNumerator",s.frameRate.denominator>0?s.frameRate.denominator:1);s.timebaseDenominator=getI(p,"timebaseDenominator",s.frameRate.numerator>0?s.frameRate.numerator:30);s.pixelAspectNumerator=getI(p,"pixelAspectNumerator",1);s.pixelAspectDenominator=getI(p,"pixelAspectDenominator",1);s.displayAspectNumerator=getI(p,"displayAspectNumerator",s.width);s.displayAspectDenominator=getI(p,"displayAspectDenominator",s.height);s.colorSpace=getS(p,"colorSpace","bt709");s.colorRange=getS(p,"colorRange","limited");s.colorPrimaries=getS(p,"colorPrimaries","bt709");s.transferCharacteristics=getS(p,"transferCharacteristics","bt709");s.matrixCoefficients=getS(p,"matrixCoefficients","bt709");s.audioSampleRate=getI(p,"audioSampleRate",48000);s.audioChannels=getI(p,"audioChannels",2);s.audioChannelLayout=getS(p,"audioChannelLayout",s.audioChannels==1?"mono":s.audioChannels==2?"stereo":"unknown");s.exportContainer=getS(p,"exportContainer","mp4");s.videoCodec=getS(p,"videoCodec","libx264");s.audioCodec=getS(p,"audioCodec","aac");return s;}
ptree clipTo(const Clip&c){ptree p;p.put("id",c.id);p.put("assetId",c.assetId);p.put("name",c.name);p.put("mediaType",c.mediaType);p.put("trackId",c.trackId);p.put("timelineStart",c.timelineStart);p.put("sourceIn",c.sourceIn);p.put("sourceOut",c.sourceOut);p.put("playbackRate",c.playbackRate);p.put("enabled",c.enabled);p.put("linkedAudio",c.linkedAudio);p.put("volume",c.volume);p.put("opacity",c.opacity);if(c.linkedClipId)p.put("linkedClipId",*c.linkedClipId);if(c.groupId)p.put("groupId",*c.groupId);if(c.nestedSequenceId)p.put("nestedSequenceId",*c.nestedSequenceId);ptree keys;for(auto&k:c.keyframes){ptree x;x.put("id",k.id);x.put("property",k.property);x.put("interpolation",k.interpolation);x.put("time",k.time);x.put("value",k.value);keys.push_back({"",x});}p.add_child("keyframes",keys);ptree effects;for(auto&e:c.effects){ptree x;x.put("id",e.id);x.put("type",e.type);x.put("enabled",e.enabled);x.add_child("parameters",e.parameters);effects.push_back({"",x});}p.add_child("effects",effects);p.add_child("legacyFields",c.legacyFields);return p;}
Clip clipFrom(const ptree&p){Clip c;c.id=getS(p,"id");c.assetId=getS(p,"assetId");c.name=getS(p,"name");c.mediaType=getS(p,"mediaType","video");c.trackId=getS(p,"trackId");c.timelineStart=getD(p,"timelineStart",getD(p,"start",0));c.sourceIn=getD(p,"sourceIn",getD(p,"in",0));c.sourceOut=getD(p,"sourceOut",getD(p,"out",0));c.playbackRate=getD(p,"playbackRate",getD(p,"speed",1));c.enabled=getB(p,"enabled",true);c.linkedAudio=getB(p,"linkedAudio",false);c.volume=getD(p,"volume",1);c.opacity=getD(p,"opacity",1);if(auto v=p.get_optional<std::string>("linkedClipId"))c.linkedClipId=*v;if(auto v=p.get_optional<std::string>("groupId"))c.groupId=*v;if(auto v=p.get_optional<std::string>("nestedSequenceId"))c.nestedSequenceId=*v;if(auto ks=p.get_child_optional("keyframes"))for(auto&kv:*ks){auto&x=kv.second;Keyframe k;k.id=getS(x,"id",newId("key"));k.property=getS(x,"property");k.interpolation=getS(x,"interpolation","linear");k.time=getD(x,"time");k.value=getD(x,"value");c.keyframes.push_back(k);}if(auto es=p.get_child_optional("effects"))for(auto&ev:*es){auto&x=ev.second;Effect e;e.id=getS(x,"id",newId("fx"));e.type=getS(x,"type");e.enabled=getB(x,"enabled",true);if(auto v=x.get_child_optional("parameters"))e.parameters=*v;c.effects.push_back(e);}if(auto lf=p.get_child_optional("legacyFields"))c.legacyFields=*lf;return c;}
ptree trackTo(const Track&t){ptree p;p.put("id",t.id);p.put("name",t.name);p.put("type",t.type);p.put("order",t.order);p.put("muted",t.muted);p.put("solo",t.solo);p.put("visible",t.visible);p.put("locked",t.locked);p.put("gain",t.gain);p.put("opacity",t.opacity);if(t.parentTrackId)p.put("parentTrackId",*t.parentTrackId);return p;}
Track trackFrom(const ptree&p){Track t;t.id=getS(p,"id");t.name=getS(p,"name");t.type=getS(p,"type","video");t.order=getI(p,"order");t.muted=getB(p,"muted");t.solo=getB(p,"solo");t.visible=getB(p,"visible",true);t.locked=getB(p,"locked");t.gain=getD(p,"gain",1);t.opacity=getD(p,"opacity",1);if(auto v=p.get_optional<std::string>("parentTrackId"))t.parentTrackId=*v;return t;}

// Convert Electron's persisted { tl, media, sequences } envelope into the native schema.
// Unknown fields remain attached to each clip and the original source JSON is retained
// separately by fromTree/loadProject so a future Electron export can preserve them.
ptree electronWrapperToNative(const ptree& input) {
 const auto timelineOpt=input.get_child_optional("tl");
 if(!timelineOpt) return input;
 const ptree& rootTimeline=*timelineOpt;
 ptree out; out.put("format","frosty-project"); out.put("schemaVersion",ProjectSchemaVersion);
 out.put("id",getS(input,"id",getS(rootTimeline,"id","electron-project")));
 out.put("name",getS(input,"name",getS(rootTimeline,"name","Untitled")));
 if(auto settings=rootTimeline.get_child_optional("settings")) out.add_child("settings",*settings); else { ptree st;st.put("width",getI(rootTimeline,"width",1920));st.put("height",getI(rootTimeline,"height",1080));st.put("fps",getI(rootTimeline,"fps",30));out.add_child("settings",st); }
 std::map<std::string,std::string> assetByPath;
 std::set<std::string> assetIds;
 ptree assets;
 if(auto media=input.get_child_optional("media")) {
  std::size_t index=0;
  for(const auto& entry:*media) {
   const ptree& m=entry.second; Asset a;
   a.path=getS(m,"path",getS(m,"src")); a.name=getS(m,"name",std::filesystem::path(a.path).filename().string());
   a.id=getS(m,"id", "electron-asset-"+std::to_string(++index));
   if(a.id.empty())a.id="electron-asset-"+std::to_string(index);
   const std::string requestedId=a.id;int collision=1;while(assetIds.contains(a.id))a.id=requestedId+"-"+std::to_string(++collision);
   a.mediaType=getS(m,"type",getS(m,"mediaType","video"));a.duration=getD(m,"duration",0);a.missing=getB(m,"missing",false);
   if(!a.path.empty())assetByPath[a.path]=a.id;
   assetIds.insert(a.id);
   ptree q;q.put("id",a.id);q.put("path",a.path);q.put("name",a.name);q.put("mediaType",a.mediaType);q.put("duration",a.duration);q.put("missing",a.missing);assets.push_back({"",q});
  }
 }
 auto makeSequence=[&](const std::string& sid,const std::string& sname,const ptree& tl) {
  ptree q;q.put("id",sid);q.put("name",sname.empty()?getS(tl,"name","Sequence"):sname);
  if(auto st=tl.get_child_optional("settings"))q.add_child("settings",*st);else q.add_child("settings",out.get_child("settings"));
  std::vector<Track> tracks;std::map<std::string,std::map<int,std::string>> localTrackIds;
  auto ensureTrack=[&](int n,const std::string& type)->std::string {
   n=std::clamp(n,1,64);auto& map=localTrackIds[type];
   while(static_cast<int>(map.size())<n){const int number=static_cast<int>(map.size())+1;Track t;t.id="electron-track-"+sid+"-"+type+"-"+std::to_string(number);t.type=type;t.name=(type=="audio"?"A":type=="title"?"T":"V")+std::to_string(number);t.order=static_cast<int>(tracks.size());map[number]=t.id;tracks.push_back(t);}
   return map[n];
  };
  ensureTrack(1,"video");
  const int trackCount=std::clamp(getI(tl,"trackCount",2),1,64);
  for(int n=1;n<=trackCount;++n)ensureTrack(n,"video");
  if(auto states=tl.get_child_optional("trackState"))for(const auto& state:*states){try{int n=std::stoi(state.first);auto id=localTrackIds["video"].find(n);if(id==localTrackIds["video"].end())continue;auto it=std::find_if(tracks.begin(),tracks.end(),[&](const Track&t){return t.id==id->second;});if(it!=tracks.end()){it->name=getS(state.second,"name",it->name);it->visible=getB(state.second,"visible",true);it->muted=getB(state.second,"muted",false);it->locked=getB(state.second,"locked",false);}}catch(...){}}
  ptree clipArray;const std::string mode=getS(tl,"mode","sequential");double sequentialCursor=0,previousDuration=0;
  auto convertLane=[&](const ptree& lane,const std::string& kind){
   for(const auto& entry:lane){const ptree& src=entry.second;Clip c;c.id=getS(src,"id",newId("clip"));c.name=getS(src,"name",getS(src,"src"));c.mediaType=getS(src,"type",kind=="layer"?"video":kind);c.sourceIn=std::max(0.0,getD(src,"in",0));c.sourceOut=getD(src,"out",getD(src,"duration",kind=="text"?getD(src,"dur",0):0));c.playbackRate=std::max(0.001,getD(src,"speed",1));
    int trackNum=getI(src,"track",kind=="layer"?2:1);const std::string trackType=kind=="audio"?"audio":kind=="text"?"title":"video";c.trackId=ensureTrack(std::max(1,trackNum),trackType);
    c.timelineStart=std::max(0.0,getD(src,"start",0));
    if(kind=="video"&&mode!="free") {double overlap=0;if(auto trans=src.get_child_optional("trans"))overlap=std::max(0.0,getD(*trans,"dur",0));const double duration=std::max(0.0,(c.sourceOut-c.sourceIn)/c.playbackRate);overlap=std::min(overlap,std::min(previousDuration,duration));c.timelineStart=std::max(0.0,sequentialCursor-overlap);sequentialCursor=c.timelineStart+duration;previousDuration=duration;}
    c.volume=std::clamp(getD(src,"volume",1),0.0,4.0);c.opacity=std::clamp(getD(src,"opacity",getD(src,"transform.alpha",getD(src,"alpha",1))),0.0,1.0);c.enabled=getB(src,"enabled",true);c.legacyFields=src;
    const std::string mediaPath=getS(src,"src");if(getS(src,"type")!="sequence"&&!mediaPath.empty()){
      auto found=assetByPath.find(mediaPath);if(found==assetByPath.end()){Asset a;a.id=getS(src,"assetId","electron-asset-imported-"+std::to_string(assetByPath.size()+1));while(assetIds.contains(a.id))a.id+="-x";a.path=mediaPath;a.name=c.name.empty()?std::filesystem::path(mediaPath).filename().string():c.name;a.mediaType=c.mediaType;a.duration=std::max(c.sourceOut,0.0);ptree aq;aq.put("id",a.id);aq.put("path",a.path);aq.put("name",a.name);aq.put("mediaType",a.mediaType);aq.put("duration",a.duration);aq.put("missing",true);assets.push_back({"",aq});assetByPath[mediaPath]=a.id;assetIds.insert(a.id);found=assetByPath.find(mediaPath);}c.assetId=found->second;
    }
    if(getS(src,"type")=="sequence"){c.mediaType="sequence";c.nestedSequenceId=getS(src,"sequenceId");c.sourceOut=std::max(c.sourceOut,0.001);}
    ptree cq=clipTo(c);clipArray.push_back({"",cq});
   }
  };
  if(auto lane=tl.get_child_optional("video"))convertLane(*lane,"video");
  if(auto lane=tl.get_child_optional("layers"))convertLane(*lane,"layer");
  if(auto lane=tl.get_child_optional("audio"))convertLane(*lane,"audio");
  if(auto lane=tl.get_child_optional("text"))convertLane(*lane,"text");
  ptree trackArray;for(const auto&t:tracks)trackArray.push_back({"",trackTo(t)});q.add_child("tracks",trackArray);
  q.add_child("clips",clipArray);
  ptree empty;for(const char* field:{"markers","groups","transitions","nestedSequenceIds"})q.add_child(field,empty);
  return q;
 };
 ptree seqs;std::string rootId=getS(rootTimeline,"id","root");if(rootId.empty())rootId="root";
 seqs.push_back({"",makeSequence(rootId,getS(rootTimeline,"name","Main sequence"),rootTimeline)});
 if(auto childSeqs=input.get_child_optional("sequences"))for(const auto& item:*childSeqs){const std::string sid=item.first.empty()?getS(item.second,"id",newId("seq")):item.first;if(sid==rootId)continue;seqs.push_back({"",makeSequence(sid,getS(item.second,"name","Sequence"),item.second)});}
 out.add_child("assets",assets);out.add_child("sequences",seqs);out.put("activeSequenceId",rootId);out.add_child("legacyPayload",input);
 return out;
}
ptree toTree(const Project&x){ptree p;p.put("format","frosty-project");p.put("schemaVersion",ProjectSchemaVersion);p.put("id",x.id);p.put("name",x.name);p.put("settings","");p.put_child("settings",settingsTo(x.settings));p.put("activeSequenceId",x.activeSequenceId);ptree assets;for(auto&a:x.assets){ptree q;q.put("id",a.id);q.put("path",a.path);q.put("name",a.name);q.put("mediaType",a.mediaType);q.put("duration",a.duration);q.put("missing",a.missing);if(a.checksum)q.put("checksum",*a.checksum);assets.push_back({"",q});}p.add_child("assets",assets);ptree seqs;for(auto&s:x.sequences){ptree q;q.put("id",s.id);q.put("name",s.name);q.add_child("settings",settingsTo(s.settings));ptree tracks;for(auto&t:s.tracks)tracks.push_back({"",trackTo(t)});q.add_child("tracks",tracks);ptree clips;for(auto&c:s.clips)clips.push_back({"",clipTo(c)});q.add_child("clips",clips);ptree markers;for(auto&m:s.markers){ptree z;z.put("id",m.id);z.put("name",m.name);z.put("time",m.time);if(m.duration)z.put("duration",*m.duration);markers.push_back({"",z});}q.add_child("markers",markers);ptree groups;for(const auto&g:s.groups){ptree z;z.put("id",g.id);z.put("name",g.name);ptree ids;for(const auto&id:g.clipIds){ptree v;v.put_value(id);ids.push_back({"",v});}z.add_child("clipIds",ids);groups.push_back({"",z});}q.add_child("groups",groups);ptree transitions;for(const auto&t:s.transitions){ptree z;z.put("id",t.id);z.put("type",t.type);z.put("trackId",t.trackId);z.put("fromClipId",t.fromClipId);z.put("toClipId",t.toClipId);z.put("start",t.start);z.put("duration",t.duration);z.put("audio",t.audio);z.add_child("parameters",t.parameters);transitions.push_back({"",z});}q.add_child("transitions",transitions);ptree nested;for(auto&id:s.nestedSequenceIds){ptree z;z.put_value(id);nested.push_back({"",z});}q.add_child("nestedSequenceIds",nested);seqs.push_back({"",q});}p.add_child("sequences",seqs);p.add_child("legacyPayload",x.legacyPayload);p.put("legacySourceJson",x.legacySourceJson);return p;}
Project fromTree(const ptree& input){const ptree normalized= input.get_child_optional("tl") ? electronWrapperToNative(input) : input; const ptree& p=normalized;Project x;x.schemaVersion=getI(p,"schemaVersion",0);x.id=getS(p,"id",newId("project"));x.name=getS(p,"name","Untitled");if(auto s=p.get_child_optional("settings"))x.settings=settingsFrom(*s);else x.settings=settingsFrom(p);x.activeSequenceId=getS(p,"activeSequenceId");x.legacySourceJson=getS(p,"legacySourceJson");if(auto a=p.get_child_optional("assets"))for(auto&v:*a){auto&q=v.second;Asset z;z.id=getS(q,"id");z.path=getS(q,"path",getS(q,"src"));z.name=getS(q,"name",std::filesystem::path(z.path).filename().string());z.mediaType=getS(q,"mediaType",getS(q,"type","video"));z.duration=getD(q,"duration",getD(q,"out",0));z.missing=getB(q,"missing");if(auto c=q.get_optional<std::string>("checksum"))z.checksum=*c;x.assets.push_back(z);}if(auto ss=p.get_child_optional("sequences"))for(auto&v:*ss){auto&q=v.second;Sequence s;s.id=getS(q,"id",newId("seq"));s.name=getS(q,"name","Sequence");if(auto set=q.get_child_optional("settings"))s.settings=settingsFrom(*set);else s.settings=x.settings;if(auto ts=q.get_child_optional("tracks"))for(auto&t:*ts)s.tracks.push_back(trackFrom(t.second));if(auto cs=q.get_child_optional("clips"))for(auto&c:*cs)s.clips.push_back(clipFrom(c.second));if(auto ms=q.get_child_optional("markers"))for(auto&m:*ms){Marker z;z.id=getS(m.second,"id",newId("mark"));z.name=getS(m.second,"name");z.time=getD(m.second,"time");if(auto d=m.second.get_optional<double>("duration"))z.duration=*d;s.markers.push_back(z);}if(auto ms=q.get_child_optional("groups"))for(auto&v:*ms){Group g;g.id=getS(v.second,"id",newId("group"));g.name=getS(v.second,"name","Group");if(auto ids=v.second.get_child_optional("clipIds"))for(auto&id:*ids)g.clipIds.push_back(id.second.get_value<std::string>());s.groups.push_back(std::move(g));}if(auto ts=q.get_child_optional("transitions"))for(auto&v:*ts){Transition t;t.id=getS(v.second,"id",newId("transition"));t.type=getS(v.second,"type","crossfade");t.trackId=getS(v.second,"trackId");t.fromClipId=getS(v.second,"fromClipId");t.toClipId=getS(v.second,"toClipId");t.start=getD(v.second,"start");t.duration=getD(v.second,"duration",0.5);t.audio=getB(v.second,"audio",false);if(auto params=v.second.get_child_optional("parameters"))t.parameters=*params;s.transitions.push_back(std::move(t));}if(auto ns=q.get_child_optional("nestedSequenceIds"))for(auto&n:*ns)s.nestedSequenceIds.push_back(n.second.get_value<std::string>());x.sequences.push_back(s);}if(auto lp=p.get_child_optional("legacyPayload"))x.legacyPayload=*lp;
// Preserve original Electron wrapper exactly in the structured payload as well as legacySourceJson.
if(input.get_child_optional("tl")) x.legacyPayload=input;
// Legacy v0/v1 .frosty migration: preserve old fields and translate known lanes.
if(x.sequences.empty()){
 Sequence s;s.id=newId("seq");s.name="Sequence 1";s.settings=x.settings;
 std::map<std::string,std::map<int,std::string>> trackIds;
 auto ensureTrack=[&](int n,const std::string& type){auto& map=trackIds[type];while(static_cast<int>(map.size())<n){Track t;t.id=newId("track");const int ordinal=static_cast<int>(map.size())+1;t.type=type;t.name=(type=="audio"?"A":type=="title"?"T":"V")+std::to_string(ordinal);t.order=static_cast<int>(s.tracks.size());map[ordinal]=t.id;s.tracks.push_back(t);}return map[n];};
 ensureTrack(1,"video");const std::string mode=getS(p,"mode","sequential");double sequentialCursor=0,previousDuration=0;
 auto convert=[&](const ptree& lane,const std::string& kind){for(const auto& v:lane){const ptree& q=v.second;Clip c;c.id=getS(q,"id",newId("clip"));c.name=getS(q,"name",getS(q,"src"));c.assetId=getS(q,"assetId");c.mediaType=getS(q,"type",kind=="layer"?"video":kind);c.sourceIn=getD(q,"in",0);c.sourceOut=getD(q,"out",getD(q,"duration",0));c.playbackRate=getD(q,"speed",1);c.timelineStart=getD(q,"start",0);const std::string trackType=kind=="audio"?"audio":kind=="text"?"title":"video";int trackNumber=getI(q,"track",kind=="layer"?2:1);c.trackId=ensureTrack(std::max(1,trackNumber),trackType);c.volume=getD(q,"volume",1);c.opacity=getD(q,"opacity",getD(q,"alpha",1));c.legacyFields=q;
 if(kind=="video"&&mode!="free"){double overlap=0;if(auto trans=q.get_child_optional("trans"))overlap=std::max(0.0,trans->get<double>("dur",0));const double dur=std::max(0.0,(c.sourceOut-c.sourceIn)/std::max(0.001,c.playbackRate));overlap=std::min(overlap,std::min(previousDuration,dur));c.timelineStart=std::max(0.0,sequentialCursor-overlap);sequentialCursor=c.timelineStart+dur;previousDuration=dur;}
 if(c.assetId.empty()){for(auto& a:x.assets)if(a.path==getS(q,"src")){c.assetId=a.id;break;}if(c.assetId.empty()&&!getS(q,"src").empty()){Asset a;a.id=newId("asset");a.path=getS(q,"src");a.name=getS(q,"name",std::filesystem::path(a.path).filename().string());a.mediaType=c.mediaType;a.duration=std::max(0.0,c.sourceOut);x.assets.push_back(a);c.assetId=a.id;}}s.clips.push_back(c);}};
 if(auto v=p.get_child_optional("video"))convert(*v,"video");
 if(auto v=p.get_child_optional("layers"))convert(*v,"layer");
 if(auto v=p.get_child_optional("audio"))convert(*v,"audio");
 if(auto v=p.get_child_optional("text"))convert(*v,"text");
 const int requestedTracks=std::clamp(getI(p,"trackCount",1),1,64);for(int i=1;i<=requestedTracks;++i)ensureTrack(i,"video");
 if(auto states=p.get_child_optional("trackState")){for(const auto& state:*states){try{int index=std::stoi(state.first);auto idIt=trackIds["video"].find(index);if(idIt==trackIds["video"].end())continue;auto t=std::find_if(s.tracks.begin(),s.tracks.end(),[&](const Track& x){return x.id==idIt->second;});if(t==s.tracks.end())continue;t->name=getS(state.second,"name",t->name);t->visible=getB(state.second,"visible",true);t->muted=getB(state.second,"muted",false);t->locked=getB(state.second,"locked",false);}catch(...){}}}
 x.legacyPayload=p;x.sequences.push_back(s);x.activeSequenceId=s.id;
}
if(x.activeSequenceId.empty()&&!x.sequences.empty()){x.activeSequenceId=x.sequences.front().id;}x.schemaVersion=ProjectSchemaVersion;return x;}
void writeTree(const ptree&p,const std::filesystem::path&path){std::ofstream out(path,std::ios::binary|std::ios::trunc);if(!out)throw std::runtime_error("Cannot open project output: "+path.string());emitJson(out,p);out<<"\n";out.flush();if(!out)throw std::runtime_error("Failed writing project: "+path.string());}
}
std::string newId(const std::string&prefix){static thread_local std::mt19937_64 rng(std::random_device{}());static std::uint64_t counter=0;auto now=std::chrono::steady_clock::now().time_since_epoch().count();std::ostringstream o;o<<prefix<<'-'<<std::hex<<now<<'-'<<rng()<<'-'<<++counter;return o.str();}
Project makeEmptyProject(){Project p;p.id=newId("project");Sequence s;s.id=newId("seq");s.name="Sequence 1";s.settings=p.settings;Track t;t.id=newId("track");t.name="V1 · Main";s.tracks.push_back(t);p.activeSequenceId=s.id;p.sequences.push_back(s);return p;}
std::string projectToJson(const Project& project){std::ostringstream out;emitJson(out,toTree(project));return out.str();}
bool ValidationReport::hasErrors()const{return std::any_of(issues.begin(),issues.end(),[](const auto&i){return i.severity=="error";});}
double clipDuration(const Clip&c){return std::max(0.0,c.sourceOut-c.sourceIn)/std::max(0.001,c.playbackRate);}
double evaluateKeyframe(const Clip& clip, const std::string& prop, double time, double defaultValue) {
 std::vector<Keyframe> keys;for(const auto& k:clip.keyframes)if(k.property==prop)keys.push_back(k);
 if(keys.empty())return defaultValue;
 std::sort(keys.begin(),keys.end(),[](const Keyframe& a,const Keyframe& b){return a.time<b.time;});
 if(time<=keys.front().time)return keys.front().value;
 if(time>=keys.back().time)return keys.back().value;
 for(std::size_t i=0;i+1<keys.size();++i){
  if(time>=keys[i].time&&time<=keys[i+1].time){
   const double t0=keys[i].time, t1=keys[i+1].time;
   const double v0=keys[i].value, v1=keys[i+1].value;
   if(t1<=t0)return v0;
   const double factor=(time-t0)/(t1-t0);
   if(keys[i].interpolation=="constant")return v0;
   if(keys[i].interpolation=="smoothstep"){
    const double s=factor*factor*(3.0-2.0*factor);
    return v0+(v1-v0)*s;
   }
   return v0+(v1-v0)*factor;
  }
 }
 return defaultValue;
}
ValidationReport validateAndRepair(Project& p,bool repair){
 ValidationReport r;auto issue=[&](std::string sev,std::string code,std::string msg,std::string id=""){r.issues.push_back({std::move(sev),std::move(code),std::move(msg),std::move(id)});};
 const std::set<std::string> knownTopLevel={"format","schemaVersion","id","name","settings","activeSequenceId","assets","sequences","legacyPayload","legacySourceJson","mode","width","height","fps","frameRate","video","layers","audio","text","trackCount","trackState","music","trans","pos","duration","start","in","out","speed","version","export","effects","markers","projectSettings"};
 for(const auto& field:p.legacyPayload)if(!knownTopLevel.contains(field.first))issue("warning","project.unknownField","Unknown project field preserved for compatibility: "+field.first);
 if(p.id.empty()){issue("error","project.id","Project has no ID");if(repair){p.id=newId("project");++r.repaired;}}
 auto checkSettings=[&](ProjectSettings& s,const std::string& id){if(s.width<=0||s.height<=0){issue("error","settings.dimensions","Resolution must be positive",id);if(repair){s.width=1920;s.height=1080;++r.repaired;}}if(s.frameRate.numerator<=0||s.frameRate.denominator<=0){issue("error","settings.frameRate","Frame rate rational must be positive",id);if(repair){s.frameRate={30,1};++r.repaired;}}if(s.pixelAspectNumerator<=0||s.pixelAspectDenominator<=0){issue("error","settings.pixelAspect","Pixel aspect ratio must be positive",id);if(repair){s.pixelAspectNumerator=1;s.pixelAspectDenominator=1;++r.repaired;}}if(s.timebaseNumerator<=0||s.timebaseDenominator<=0){issue("error","settings.timebase","Timebase rational must be positive",id);if(repair){s.timebaseNumerator=std::max(1,s.frameRate.denominator);s.timebaseDenominator=std::max(1,s.frameRate.numerator);++r.repaired;}}if(s.displayAspectNumerator<=0||s.displayAspectDenominator<=0){issue("error","settings.displayAspect","Display aspect ratio must be positive",id);if(repair){s.displayAspectNumerator=std::max(1,s.width);s.displayAspectDenominator=std::max(1,s.height);++r.repaired;}}if(s.audioSampleRate<8000||s.audioSampleRate>768000){issue("error","settings.audioSampleRate","Audio sample rate is outside supported bounds",id);if(repair){s.audioSampleRate=48000;++r.repaired;}}if(s.audioChannels<1||s.audioChannels>32){issue("error","settings.audioChannels","Audio channel count is outside supported bounds",id);if(repair){s.audioChannels=2;++r.repaired;}}if(s.audioChannelLayout.empty()){issue("warning","settings.audioLayout","Audio channel layout is empty",id);if(repair){s.audioChannelLayout=s.audioChannels==1?"mono":s.audioChannels==2?"stereo":"unknown";++r.repaired;}}};checkSettings(p.settings,p.id);
 std::set<std::string> ids;auto unique=[&](std::string& id,const std::string&kind){if(id.empty()||!ids.insert(id).second){issue("error","id.duplicate","Missing or duplicate stable ID",id);if(repair){id=newId(kind);ids.insert(id);++r.repaired;}}};unique(p.id,"project");for(auto& a:p.assets){unique(a.id,"asset");if(a.missing)issue("warning","asset.missing","Media asset is marked missing and may need relinking: "+a.path,a.id);if(!std::isfinite(a.duration)||a.duration<0){issue("warning","asset.duration","Asset duration must be finite and non-negative",a.id);if(repair){a.duration=std::max(0.0,std::isfinite(a.duration)?a.duration:0.0);++r.repaired;}}}
 for(auto& seq:p.sequences){unique(seq.id,"sequence");checkSettings(seq.settings,seq.id);for(std::size_t ti=0;ti<seq.tracks.size();++ti){auto&t=seq.tracks[ti];unique(t.id,"track");if(t.order<0){issue("warning","track.order","Track order cannot be negative",t.id);if(repair){t.order=static_cast<int>(ti);++r.repaired;}}if(!std::isfinite(t.gain)||t.gain<0){issue("warning","track.gain","Track gain must be finite and non-negative",t.id);if(repair){t.gain=1;++r.repaired;}}if(!std::isfinite(t.opacity)||t.opacity<0||t.opacity>1){issue("warning","track.opacity","Track opacity must be between zero and one",t.id);if(repair){t.opacity=std::clamp(std::isfinite(t.opacity)?t.opacity:1.0,0.0,1.0);++r.repaired;}}}for(auto& g:seq.groups)unique(g.id,"group");for(auto& t:seq.transitions)unique(t.id,"transition");for(auto& c:seq.clips){unique(c.id,"clip");if(c.sourceIn<0||c.sourceOut<c.sourceIn){issue("error","clip.sourceRange","Clip source range is invalid",c.id);if(repair){c.sourceIn=std::max(0.0,c.sourceIn);c.sourceOut=std::max(c.sourceIn,c.sourceOut);++r.repaired;}}if(!std::isfinite(c.playbackRate)||c.playbackRate<=0){issue("error","clip.rate","Playback rate must be positive",c.id);if(repair){c.playbackRate=1;++r.repaired;}}if(!std::isfinite(c.timelineStart)||c.timelineStart<0){issue("warning","clip.start","Invalid timeline start was clamped",c.id);if(repair){c.timelineStart=std::max(0.0,std::isfinite(c.timelineStart)?c.timelineStart:0.0);++r.repaired;}}if(!std::isfinite(c.volume)||c.volume<0){issue("warning","clip.volume","Invalid clip volume",c.id);if(repair){c.volume=1;++r.repaired;}}if(!std::isfinite(c.opacity)||c.opacity<0||c.opacity>1){issue("warning","clip.opacity","Clip opacity must be between zero and one",c.id);if(repair){c.opacity=std::clamp(c.opacity,0.0,1.0);++r.repaired;}}for(auto& k:c.keyframes){unique(k.id,"keyframe");if(!std::isfinite(k.time)||k.time<0||!std::isfinite(k.value)){issue("warning","keyframe.value","Keyframe time/value is invalid",k.id);if(repair){k.time=std::max(0.0,std::isfinite(k.time)?k.time:0.0);k.value=std::isfinite(k.value)?k.value:0.0;++r.repaired;}}}for(auto& e:c.effects)unique(e.id,"effect");}for(auto& m:seq.markers){unique(m.id,"marker");if(!std::isfinite(m.time)||m.time<0){issue("warning","marker.time","Invalid marker time",m.id);if(repair){m.time=std::max(0.0,std::isfinite(m.time)?m.time:0.0);++r.repaired;}}if(m.duration&&(!std::isfinite(*m.duration)||*m.duration<0)){issue("warning","marker.duration","Marker duration is invalid",m.id);if(repair){m.duration=std::max(0.0,std::isfinite(*m.duration)?*m.duration:0.0);++r.repaired;}}}}
 std::set<std::string> assetIds;for(const auto&a:p.assets)assetIds.insert(a.id);std::set<std::string> sequenceIds;for(const auto&seq:p.sequences)sequenceIds.insert(seq.id);
 for(auto& seq:p.sequences){std::set<std::string> trackIds,clipIds,groupIds;for(const auto&t:seq.tracks)trackIds.insert(t.id);for(const auto&c:seq.clips)clipIds.insert(c.id);for(const auto&g:seq.groups)groupIds.insert(g.id);for(auto&t:seq.tracks)if(t.parentTrackId&&!trackIds.contains(*t.parentTrackId)){issue("warning","track.parent","Track routing references a missing parent track",t.id);if(repair){t.parentTrackId.reset();++r.repaired;}}for(auto&c:seq.clips){if(c.groupId&&!groupIds.contains(*c.groupId)){issue("warning","clip.group","Clip references a missing group",c.id);if(repair){c.groupId.reset();++r.repaired;}}if(!c.trackId.empty()&&!trackIds.contains(c.trackId)){issue("error","clip.track","Clip references missing track",c.id);if(repair&&!seq.tracks.empty()){c.trackId=seq.tracks.front().id;++r.repaired;}}if(!c.assetId.empty()&&!assetIds.contains(c.assetId)){issue("error","clip.asset","Clip references a missing asset",c.id);if(repair){Asset a;a.id=newId("asset");a.name=c.name;a.path=c.legacyFields.get<std::string>("src","");a.mediaType=c.mediaType;a.duration=std::max(0.0,c.sourceOut);a.missing=true;c.assetId=a.id;p.assets.push_back(a);assetIds.insert(a.id);++r.repaired;}}if(!c.assetId.empty()){auto source=std::find_if(p.assets.begin(),p.assets.end(),[&](const Asset& a){return a.id==c.assetId;});if(source!=p.assets.end()&&!source->missing&&source->duration>0&&c.sourceOut>source->duration+1e-6){issue("error","clip.sourceRange.assetDuration","Clip source-out exceeds the asset duration",c.id);if(repair){c.sourceOut=source->duration;const double epsilon=std::min(0.001,c.sourceOut);c.sourceIn=std::min(c.sourceIn,std::max(0.0,c.sourceOut-epsilon));++r.repaired;}}}if(c.linkedClipId&&!clipIds.contains(*c.linkedClipId)){issue("warning","clip.link","Linked clip reference is missing",c.id);if(repair){c.linkedClipId.reset();++r.repaired;}}if(c.nestedSequenceId&&!sequenceIds.contains(*c.nestedSequenceId)){issue("error","sequence.reference","Nested sequence reference is missing",c.id);if(repair){c.nestedSequenceId.reset();++r.repaired;}}}for(auto&g:seq.groups){for(auto it=g.clipIds.begin();it!=g.clipIds.end();){if(!clipIds.contains(*it)){issue("warning","group.clip","Group references a missing clip",g.id);if(repair){it=g.clipIds.erase(it);++r.repaired;continue;}}++it;}}for(auto&t:seq.transitions){const bool validRange=std::isfinite(t.start)&&std::isfinite(t.duration)&&t.start>=0&&t.duration>0;const bool validClips=(t.fromClipId.empty()||clipIds.contains(t.fromClipId))&&(t.toClipId.empty()||clipIds.contains(t.toClipId));const bool validTrack=t.trackId.empty()||trackIds.contains(t.trackId);if(!validRange||!validClips||!validTrack){issue("error","transition.invalid","Transition has an invalid range or reference",t.id);if(repair){t.start=std::max(0.0,std::isfinite(t.start)?t.start:0.0);t.duration=std::max(0.001,std::isfinite(t.duration)?t.duration:0.5);if(!validClips){if(!clipIds.contains(t.fromClipId))t.fromClipId.clear();if(!clipIds.contains(t.toClipId))t.toClipId.clear();}if(!validTrack)t.trackId.clear();++r.repaired;}}}}
 std::function<bool(const std::string&,const std::string&,std::set<std::string>&)> reaches=[&](const std::string& from,const std::string& target,std::set<std::string>& seen){if(from==target)return true;if(!seen.insert(from).second)return false;auto it=std::find_if(p.sequences.begin(),p.sequences.end(),[&](const Sequence& x){return x.id==from;});if(it==p.sequences.end())return false;for(const auto& cl:it->clips)if(cl.nestedSequenceId&&reaches(*cl.nestedSequenceId,target,seen))return true;return false;};
 for(auto& seq:p.sequences){for(auto& cl:seq.clips)if(cl.nestedSequenceId){std::set<std::string> seen;if(reaches(*cl.nestedSequenceId,seq.id,seen)){issue("error","sequence.cycle","Nested sequence cycle detected",cl.id);if(repair){cl.nestedSequenceId.reset();++r.repaired;}}}for(auto it=seq.nestedSequenceIds.begin();it!=seq.nestedSequenceIds.end();){if(!sequenceIds.contains(*it)){issue("warning","sequence.nestedReference","Nested sequence list contains a missing sequence",seq.id);if(repair){it=seq.nestedSequenceIds.erase(it);++r.repaired;continue;}}else{std::set<std::string> seen;if(reaches(*it,seq.id,seen)){issue("error","sequence.cycle","Nested sequence list creates a cycle",seq.id);if(repair){it=seq.nestedSequenceIds.erase(it);++r.repaired;continue;}}}++it;}}
 if(!p.activeSequenceId.empty()&&std::none_of(p.sequences.begin(),p.sequences.end(),[&](auto& seq){return seq.id==p.activeSequenceId;})){issue("warning","sequence.active","Active sequence is missing");if(repair&&!p.sequences.empty()){p.activeSequenceId=p.sequences.front().id;++r.repaired;}}
 return r;
}
Project loadProject(const std::filesystem::path&path,ValidationReport*report){std::ifstream input(path,std::ios::binary);if(!input)throw std::runtime_error("Cannot open project: "+path.string());std::string raw((std::istreambuf_iterator<char>(input)),{});std::istringstream stream(raw);ptree p;boost::property_tree::read_json(stream,p);const int sourceVersion=getI(p,"schemaVersion",0);if(sourceVersion>ProjectSchemaVersion)throw std::runtime_error("This project was saved by a newer Frosty schema ("+std::to_string(sourceVersion)+"); this build supports up to schema "+std::to_string(ProjectSchemaVersion)+". The project was not modified.");Project x=fromTree(p);if(x.legacySourceJson.empty())x.legacySourceJson=std::move(raw);auto r=validateAndRepair(x,true);if(report)*report=r;return x;}
void saveProjectAtomic(const Project&p,const std::filesystem::path&path){Project checked=p;auto validation=validateAndRepair(checked,false);if(validation.hasErrors())throw std::runtime_error("Project validation failed; refusing to save invalid project");auto parent=path.parent_path();if(!parent.empty())std::filesystem::create_directories(parent);auto tmp=path;tmp+= ".tmp-"+newId("write");writeTree(toTree(checked),tmp);std::error_code ec;std::filesystem::rename(tmp,path,ec);if(ec){auto backup=path;backup+=".replace-backup-"+newId("save");std::error_code bec;if(std::filesystem::exists(path))std::filesystem::rename(path,backup,bec);ec.clear();std::filesystem::rename(tmp,path,ec);if(ec){std::error_code ignored;if(std::filesystem::exists(backup))std::filesystem::rename(backup,path,ignored);std::filesystem::remove(tmp,ignored);throw std::runtime_error("Atomic project replacement failed: "+ec.message());}std::filesystem::remove(backup,bec);}}
void saveRecoverySnapshot(const Project&p,const std::filesystem::path&path,std::size_t keep){std::filesystem::create_directories(path);auto stamp=std::chrono::system_clock::now().time_since_epoch().count();saveProjectAtomic(p,path/("recovery-"+std::to_string(stamp)+".frosty"));std::vector<std::filesystem::directory_entry> files;for(auto&e:std::filesystem::directory_iterator(path))if(e.is_regular_file()&&e.path().extension()==".frosty")files.push_back(e);std::sort(files.begin(),files.end(),[](auto&a,auto&b){return a.last_write_time()>b.last_write_time();});for(std::size_t i=keep;i<files.size();++i){std::error_code ec;std::filesystem::remove(files[i],ec);}}
Project recoverLatestSnapshot(const std::filesystem::path&dir){std::filesystem::directory_entry latest;for(auto&e:std::filesystem::directory_iterator(dir))if(e.is_regular_file()&&e.path().extension()==".frosty"&&(!latest.exists()||e.last_write_time()>latest.last_write_time()))latest=e;if(!latest.exists())throw std::runtime_error("No recovery snapshots found");return loadProject(latest.path());}
EditResult applyTimelineEdit(Project& p,const std::string& sid,EditKind kind,double start,double end){
 if(!std::isfinite(start)||!std::isfinite(end)||start<0||end<start)return{false,"Invalid edit range"};
 auto si=std::find_if(p.sequences.begin(),p.sequences.end(),[&](auto& s){return s.id==sid;});
 if(si==p.sequences.end())return{false,"Sequence not found"};
 const double amount=end-start;if(amount<=0)return{false,"Edit range must have positive duration"};
 auto& s=*si;
 auto trackLocked=[&](const Clip& c){auto t=std::find_if(s.tracks.begin(),s.tracks.end(),[&](const Track& x){return x.id==c.trackId;});return t!=s.tracks.end()&&t->locked;};
 // Reject the entire transaction before touching state if a locked track would be affected.
 for(const auto& c:s.clips){const double a=c.timelineStart,b=a+clipDuration(c);bool affected=false;
   if(kind==EditKind::InsertGap)affected=(a>=start-1e-9||b>start+1e-9);
   else affected=(b>start+1e-9&&a<end-1e-9);
   if(affected&&trackLocked(c))return{false,"Edit would modify a locked track: "+c.trackId};
 }
 if(kind==EditKind::InsertGap){std::vector<Clip> out;out.reserve(s.clips.size()+2);for(const auto& original:s.clips){Clip c=original;const double a=c.timelineStart,b=a+clipDuration(c);if(a>=start){c.timelineStart+=amount;out.push_back(c);}else if(b>start){Clip right=c;right.id=newId("clip");right.timelineStart=start+amount;right.sourceIn=c.sourceIn+(start-a)*c.playbackRate;right.linkedClipId=c.id;c.sourceOut=right.sourceIn;out.push_back(c);out.push_back(right);}else out.push_back(c);}s.clips=std::move(out);return{true,"Gap inserted"};}
 if(kind==EditKind::Overwrite){std::vector<Clip> out;out.reserve(s.clips.size()+2);for(const auto& original:s.clips){Clip c=original;const double a=c.timelineStart,b=a+clipDuration(c),rate=c.playbackRate;if(b<=start||a>=end){out.push_back(c);continue;}if(a>=start&&b<=end){continue;}else if(a<start&&b>end){Clip right=c;right.id=newId("clip");right.timelineStart=end;right.sourceIn=c.sourceIn+amount*rate;right.linkedClipId=c.id;c.sourceOut=c.sourceIn+(start-a)*rate;out.push_back(c);out.push_back(right);}else if(a<start){c.sourceOut=c.sourceIn+(start-a)*rate;out.push_back(c);}else{c.sourceIn+=(end-a)*rate;c.timelineStart=end;out.push_back(c);}}s.clips=std::move(out);return{true,"Overwrite range cleared; replacement media can be placed in the range"};}
 std::vector<Clip> out;out.reserve(s.clips.size()+2);for(const auto& original:s.clips){Clip c=original;const double a=c.timelineStart,b=a+clipDuration(c),rate=c.playbackRate;if(b<=start){out.push_back(c);continue;}if(a>=end){c.timelineStart-=amount;out.push_back(c);continue;}const double left=std::max(0.0,std::min(b,start)-a),right=std::max(0.0,b-std::max(a,end));if(left>1e-9){c.sourceOut=c.sourceIn+left*rate;out.push_back(c);}if(right>1e-9){Clip r=original;if(left>1e-9){r.id=newId("clip");r.linkedClipId=original.id;}r.timelineStart=start;r.sourceIn=original.sourceIn+std::max(0.0,end-a)*rate;out.push_back(r);}}
 s.clips=std::move(out);return{true,"Ripple delete applied"};
}
EditResult applyCommand(Project& p,const TimelineCommand& cmd){
 auto si=std::find_if(p.sequences.begin(),p.sequences.end(),[&](auto& s){return s.id==cmd.sequenceId;});if(si==p.sequences.end())return{false,"Sequence not found"};auto& s=*si;
 if(cmd.kind==CommandKind::TimelineEdit){if(cmd.editKind!=EditKind::Overwrite||!cmd.replacement)return applyTimelineEdit(p,cmd.sequenceId,cmd.editKind,cmd.start,cmd.end);Clip replacement=*cmd.replacement;if(replacement.sourceIn<0||replacement.sourceOut<=replacement.sourceIn||replacement.playbackRate<=0)return{false,"Replacement clip has an invalid source range or playback rate"};if(std::none_of(s.tracks.begin(),s.tracks.end(),[&](const Track&t){return t.id==replacement.trackId;}))return{false,"Replacement clip track not found"};auto result=applyTimelineEdit(p,cmd.sequenceId,EditKind::Overwrite,cmd.start,cmd.start+clipDuration(replacement));if(!result.ok)return result;replacement.id=replacement.id.empty()?newId("clip"):replacement.id;replacement.timelineStart=cmd.start;s.clips.push_back(replacement);return{true,"Overwrite edit applied"};}
 if(cmd.kind==CommandKind::AddTrack){Track t;t.id=cmd.entityId.empty()?newId("track"):cmd.entityId;if(std::any_of(s.tracks.begin(),s.tracks.end(),[&](const Track& existing){return existing.id==t.id;}))return{false,"Track ID already exists"};t.name=cmd.text.empty()?"Track "+std::to_string(s.tracks.size()+1):cmd.text;t.type=cmd.integer==1?"audio":"video";t.order=static_cast<int>(s.tracks.size());s.tracks.push_back(t);return{true,t.id};}
 if(cmd.kind==CommandKind::SetTrackState){auto t=std::find_if(s.tracks.begin(),s.tracks.end(),[&](auto& x){return x.id==cmd.entityId;});if(t==s.tracks.end())return{false,"Track not found"};if(cmd.text=="locked")t->locked=cmd.flag;else if(cmd.text=="muted")t->muted=cmd.flag;else if(cmd.text=="solo")t->solo=cmd.flag;else if(cmd.text=="visible")t->visible=cmd.flag;else if(cmd.text=="name"){if(cmd.value.empty())return{false,"Track name cannot be empty"};t->name=cmd.value;}else if(cmd.text=="gain"){if(!std::isfinite(cmd.val)||cmd.val<0||cmd.val>4)return{false,"Track gain must be between 0 and 4"};t->gain=cmd.val;}else if(cmd.text=="opacity"){if(!std::isfinite(cmd.val)||cmd.val<0||cmd.val>1)return{false,"Track opacity must be between 0 and 1"};t->opacity=cmd.val;}else return{false,"Unknown track property"};return{true,"Track updated"};}
 if(cmd.kind==CommandKind::DeleteTransition){auto it=std::find_if(s.transitions.begin(),s.transitions.end(),[&](const Transition& t){return t.id==cmd.entityId;});if(it==s.transitions.end())return{false,"Transition not found"};s.transitions.erase(it);return{true,"Transition removed"};}
 if(cmd.kind==CommandKind::SetTransition){
  if(cmd.entityId.empty())return{false,"Transition ID is required"};
  static const std::set<std::string> allowed={"crossfade","dissolve","fade","fadeblack","none","wipeleft","wiperight","wipeup","wipedown","slideleft","slideright","circleopen","radial","pixelize"};
  if(!allowed.contains(cmd.text))return{false,"Unsupported transition type"};
  if(!std::isfinite(cmd.start)||cmd.start<0||!std::isfinite(cmd.end)||cmd.end<0.05||cmd.end>30)return{false,"Transition start/duration is outside the supported range"};
  const auto hasClip=[&](const std::string& id){return !id.empty()&&std::any_of(s.clips.begin(),s.clips.end(),[&](const Clip& c){return c.id==id;});};
  if(!hasClip(cmd.value)||!hasClip(cmd.propName)||cmd.value==cmd.propName)return{false,"Transition must reference two different existing clips"};
  if(!cmd.assetId.empty()&&std::none_of(s.tracks.begin(),s.tracks.end(),[&](const Track& t){return t.id==cmd.assetId;}))return{false,"Transition track was not found"};
  auto it=std::find_if(s.transitions.begin(),s.transitions.end(),[&](const Transition& t){return t.id==cmd.entityId;});
  Transition value;value.id=cmd.entityId;value.type=cmd.text;value.trackId=cmd.assetId;value.fromClipId=cmd.value;value.toClipId=cmd.propName;value.start=cmd.start;value.duration=cmd.end;value.audio=cmd.flag;
  if(it==s.transitions.end())s.transitions.push_back(std::move(value));else *it=std::move(value);
  return{true,"Transition updated"};
 }
 if(cmd.kind==CommandKind::AddClip){
  Track* tr=nullptr;for(auto& t:s.tracks)if(t.id==cmd.entityId){tr=&t;break;}
  if(!tr)return{false,"Target track not found"};
  if(tr->locked)return{false,"Target track is locked"};
  if(!std::isfinite(cmd.start)||cmd.start<0||!std::isfinite(cmd.time)||!std::isfinite(cmd.val)||cmd.time<0||cmd.val<=cmd.time)return{false,"Clip start and source range must be finite and valid"};
  auto asset=std::find_if(p.assets.begin(),p.assets.end(),[&](const Asset& a){return a.id==cmd.assetId;});
  if(asset==p.assets.end())return{false,"Source asset was not found in this project"};
  if(asset->missing)return{false,"Source asset is marked missing; relink it before adding a clip"};
  if(asset->mediaType=="audio"&&tr->type!="audio")return{false,"Audio assets must be placed on an audio track"};
  if((asset->mediaType=="video"||asset->mediaType=="image")&&tr->type=="audio")return{false,"Video/image assets must be placed on a video track"};
  if(asset->duration>0&&cmd.val>asset->duration+1e-6)return{false,"Clip source-out exceeds the source asset duration"};
  Clip c;c.id=newId("clip");c.trackId=cmd.entityId;c.assetId=asset->id;c.name=cmd.text.empty()?asset->name:cmd.text;c.mediaType=asset->mediaType;c.timelineStart=cmd.start;c.sourceIn=cmd.time;c.sourceOut=cmd.val;s.clips.push_back(c);return{true,c.id};
 }
 auto ci=std::find_if(s.clips.begin(),s.clips.end(),[&](auto& c){return c.id==cmd.entityId;});if(ci==s.clips.end())return{false,"Clip not found"};auto tr=std::find_if(s.tracks.begin(),s.tracks.end(),[&](auto& t){return t.id==ci->trackId;});if(tr!=s.tracks.end()&&tr->locked)return{false,"Clip is on a locked track"};
 if(cmd.kind==CommandKind::SplitClip){
  if(!std::isfinite(cmd.start))return{false,"Split time must be finite"};
  const double end=ci->timelineStart+clipDuration(*ci);
  if(cmd.start<=ci->timelineStart+1e-6||cmd.start>=end-1e-6)return{false,"Split time must fall strictly inside the clip"};
  const double relative=cmd.start-ci->timelineStart;
  const double sourceSplit=ci->sourceIn+relative*ci->playbackRate;
  if(sourceSplit<=ci->sourceIn+1e-6||sourceSplit>=ci->sourceOut-1e-6)return{false,"Split would create an empty source range"};
  Clip original=*ci;Clip right=original;right.id=newId("clip");right.timelineStart=cmd.start;right.sourceIn=sourceSplit;right.linkedClipId=original.id;
  // Both halves retain equivalent effects, but stable effect IDs must remain globally unique.
  for(auto& effect:right.effects)effect.id=newId("effect");
  // Split time-keyed properties at the boundary so both halves keep the same visible pose.
  std::set<std::string> properties;for(const auto& key:original.keyframes)properties.insert(key.property);
  ci->keyframes.clear();right.keyframes.clear();
  for(const auto& property:properties){
   std::vector<Keyframe> keys;for(const auto& key:original.keyframes)if(key.property==property)keys.push_back(key);
   std::stable_sort(keys.begin(),keys.end(),[](const Keyframe&a,const Keyframe&b){return a.time<b.time;});if(keys.empty())continue;
   const double boundary=evaluateKeyframe(original,property,relative,keys.front().value);
   const auto exact=std::find_if(keys.begin(),keys.end(),[&](const Keyframe&k){return std::abs(k.time-relative)<1e-6;});
   Keyframe leftBoundary;leftBoundary.id=newId("key");leftBoundary.property=property;leftBoundary.time=relative;leftBoundary.value=exact!=keys.end()?exact->value:boundary;leftBoundary.interpolation=exact!=keys.end()?exact->interpolation:"linear";
   for(const auto& key:keys){if(key.time<relative-1e-6)ci->keyframes.push_back(key);}
   ci->keyframes.push_back(leftBoundary);
   Keyframe rightBoundary=leftBoundary;rightBoundary.id=newId("key");rightBoundary.time=0;right.keyframes.push_back(rightBoundary);
   for(auto key:keys)if(key.time>relative+1e-6){key.time-=relative;right.keyframes.push_back(key);}
  }
  ci->sourceOut=sourceSplit;s.clips.push_back(std::move(right));return{true,"Clip split"};
 }
 if(cmd.kind==CommandKind::MoveClip){
  if(!std::isfinite(cmd.start)||cmd.start<0)return{false,"Invalid clip start"};
  if(!cmd.text.empty()&&cmd.text!=ci->trackId){
   auto target=std::find_if(s.tracks.begin(),s.tracks.end(),[&](const Track& t){return t.id==cmd.text;});
   if(target==s.tracks.end())return{false,"Target track not found"};
   if(target->locked)return{false,"Target track is locked"};
   if((ci->mediaType=="audio")!=(target->type=="audio"))return{false,"Clip media type is incompatible with target track"};
   ci->trackId=target->id;
  }
  ci->timelineStart=cmd.start;return{true,"Clip moved"};
 }
 if(cmd.kind==CommandKind::SetClipRange){if(!std::isfinite(cmd.start)||!std::isfinite(cmd.end)||cmd.start<0||cmd.end<=cmd.start)return{false,"Invalid source range"};auto asset=std::find_if(p.assets.begin(),p.assets.end(),[&](const Asset& a){return a.id==ci->assetId;});if(asset!=p.assets.end()){if(asset->missing)return{false,"Source asset is marked missing; relink it before editing the source range"};if(asset->duration>0&&cmd.end>asset->duration+1e-6)return{false,"Clip source-out exceeds the source asset duration"};}ci->sourceIn=cmd.start;ci->sourceOut=cmd.end;return{true,"Clip range updated"};}
 if(cmd.kind==CommandKind::RemoveClip){s.clips.erase(ci);return{true,"Clip removed"};}
 if(cmd.kind==CommandKind::SetClipVolume){if(!std::isfinite(cmd.val)||cmd.val<0||cmd.val>4)return{false,"Clip volume must be between 0 and 4"};ci->volume=cmd.val;return{true,"Clip volume updated"};}
 if(cmd.kind==CommandKind::SetClipProperty){
  if(cmd.propName=="name"){if(cmd.value.empty())return{false,"Clip name cannot be empty"};ci->name=cmd.value;ci->legacyFields.put("name",cmd.value);return{true,"Clip name updated"};}
  if(cmd.propName=="enabled"){ci->enabled=cmd.flag;ci->legacyFields.put("enabled",cmd.flag);return{true,"Clip enabled state updated"};}
  if(!std::isfinite(cmd.val))return{false,"Clip property value must be finite"};
  if(cmd.propName=="playbackRate"){if(cmd.val<0.05||cmd.val>16)return{false,"Playback rate must be between 0.05x and 16x"};ci->playbackRate=cmd.val;ci->legacyFields.put("speed",cmd.val);return{true,"Playback rate updated"};}
  if(cmd.propName=="opacity"||cmd.propName=="transform.alpha"){if(cmd.val<0||cmd.val>1)return{false,"Opacity must be between 0 and 1"};ci->opacity=cmd.val;ci->legacyFields.put("opacity",cmd.val);ci->legacyFields.put("transform.alpha",cmd.val);return{true,"Clip opacity updated"};}
  if(cmd.propName=="volume"){if(cmd.val<0||cmd.val>4)return{false,"Clip volume must be between 0 and 4"};ci->volume=cmd.val;ci->legacyFields.put("volume",cmd.val);return{true,"Clip volume updated"};}
  static const std::set<std::string> transformProps={"transform.x","transform.y","transform.scaleX","transform.scaleY","transform.rotation","transform.shearX","transform.shearY"};
  if(!transformProps.contains(cmd.propName))return{false,"Unsupported clip property"};
  if((cmd.propName=="transform.x"||cmd.propName=="transform.y")&&(cmd.val < -4 || cmd.val > 4))return{false,"Transform position must be between -4 and 4"};
  if((cmd.propName=="transform.scaleX"||cmd.propName=="transform.scaleY")&&(cmd.val < 0.05 || cmd.val > 8))return{false,"Transform scale must be between 0.05 and 8"};
  if(cmd.propName=="transform.rotation"&&(cmd.val < -3600 || cmd.val > 3600))return{false,"Rotation must be between -3600 and 3600 degrees"};
  if((cmd.propName=="transform.shearX"||cmd.propName=="transform.shearY")&&(cmd.val < -2 || cmd.val > 2))return{false,"Transform shear must be between -2 and 2 (FFmpeg shear factor range)"};
  ci->legacyFields.put(cmd.propName,cmd.val);return{true,"Clip transform updated"};
 }
 if(cmd.kind==CommandKind::SetClipMask){
  if(cmd.value.empty())return{false,"Mask JSON is required"};
  ptree mask;try{std::istringstream input(cmd.value);boost::property_tree::read_json(input,mask);}catch(const std::exception&){return{false,"Mask JSON is invalid"};}
  const std::string shape=getS(mask,"shape");
  if(shape!="rectangle"&&shape!="ellipse"&&shape!="path"&&shape!="bezier")return{false,"Unsupported mask shape"};
  if(shape=="bezier"){
   auto nodesOpt=mask.get_child_optional("nodes");if(!nodesOpt)return{false,"Bézier mask must contain nodes"};const auto& nodes=*nodesOpt;const auto count=nodes.size();if(count<3||count>12)return{false,"Bézier masks must contain 3–12 anchor nodes"};
   auto validCoord=[](const ptree& point){for(const char* k:{"x","y"}){auto v=point.get_optional<double>(k);if(!v||!std::isfinite(*v)||*v<0||*v>1)return false;}return true;};
   auto validNodes=[&](const ptree& list){if(list.size()!=count)return false;for(const auto& item:list){const auto& node=item.second;if(!validCoord(node))return false;auto in=node.get_child_optional("in"),out=node.get_child_optional("out");if(!in||!out||!validCoord(*in)||!validCoord(*out))return false;}return true;};
   if(!validNodes(nodes))return{false,"Bézier anchor or handle coordinates must be normalized to 0–1"};
   if(auto keys=mask.get_child_optional("pathKeyframes")){double previous=-1;bool firstKey=true;for(const auto& item:*keys){const auto& key=item.second;auto t=key.get_optional<double>("t");if(!t||!std::isfinite(*t)||*t<0||(!firstKey&&*t<=previous))return{false,"Bézier path keyframe times must be strictly increasing, finite and non-negative"};firstKey=false;previous=*t;const auto interpolation=getS(key,"interpolation","linear");if(interpolation!="linear"&&interpolation!="bezier"&&interpolation!="constant")return{false,"Unsupported Bézier path interpolation"};auto kn=key.get_child_optional("nodes");if(!kn||!validNodes(*kn))return{false,"Every Bézier path keyframe must contain the same valid anchors and handles"};}}
  }
  ci->legacyFields.put_child("mask",mask);return{true,"Clip mask updated"};
 }
 if(cmd.kind==CommandKind::SetEffect){
  if(cmd.text=="clear"){ci->effects.clear();ci->legacyFields.erase("fx");ci->legacyFields.erase("effects");return{true,"Clip effects cleared"};}
  static const std::set<std::string> allowed={"brightness","contrast","saturation","color","gamma","blur","sharpen","grayscale","sepia","invert","vignette","flip-h","flip-v","hue"};
  if(!allowed.contains(cmd.text))return{false,"Unsupported effect type"};
  if(cmd.propName.empty()||!std::isfinite(cmd.val))return{false,"Effect parameter/value is invalid"};
  auto effect=std::find_if(ci->effects.begin(),ci->effects.end(),[&](const Effect& e){return e.type==cmd.text;});
  if(effect==ci->effects.end()){Effect e;e.id=newId("effect");e.type=cmd.text;e.enabled=cmd.flag;e.parameters.put(cmd.propName,cmd.val);ci->effects.push_back(std::move(e));}
  else{effect->enabled=cmd.flag;effect->parameters.put(cmd.propName,cmd.val);}
  return{true,"Effect updated"};
 }
 if(cmd.kind==CommandKind::SetKeyframe){
  if(cmd.propName.empty())return{false,"Keyframe property name required"};
  auto kit=std::find_if(ci->keyframes.begin(),ci->keyframes.end(),[&](const Keyframe& k){return k.property==cmd.propName&&std::abs(k.time-cmd.time)<1e-6;});
  if(kit!=ci->keyframes.end()){
   kit->value=cmd.val;if(!cmd.interpolation.empty())kit->interpolation=cmd.interpolation;
  }else{
   Keyframe k;k.id=newId("key");k.property=cmd.propName;k.time=std::max(0.0,cmd.time);k.value=cmd.val;k.interpolation=cmd.interpolation.empty()?"linear":cmd.interpolation;ci->keyframes.push_back(k);
  }
  return{true,"Keyframe updated"};
 }
 return{false,"Unsupported command"};
}
CommandHistory::CommandHistory(std::size_t limit):limit_(std::max<std::size_t>(1,limit)){}
bool CommandHistory::execute(Project&p,const std::string&sid,EditKind k,double a,double b){TimelineCommand c;c.kind=CommandKind::TimelineEdit;c.sequenceId=sid;c.editKind=k;c.start=a;c.end=b;return execute(p,c);}
bool CommandHistory::execute(Project&p,const TimelineCommand& c){return execute(p,std::vector<TimelineCommand>{c});}
bool CommandHistory::execute(Project&p,const std::vector<TimelineCommand>& commands){
 if(commands.empty())return false;
 Project before=p;
 for(const auto& c:commands){auto result=applyCommand(p,c);if(!result.ok){p=std::move(before);return false;}}
 undo_.push_back(std::move(before));if(undo_.size()>limit_)undo_.erase(undo_.begin());redo_.clear();return true;
}
bool CommandHistory::undo(Project&p){if(undo_.empty())return false;redo_.push_back(p);p=std::move(undo_.back());undo_.pop_back();return true;}
bool CommandHistory::redo(Project&p){if(redo_.empty())return false;undo_.push_back(p);p=std::move(redo_.back());redo_.pop_back();return true;}
std::size_t CommandHistory::undoCount()const{return undo_.size();}std::size_t CommandHistory::redoCount()const{return redo_.size();}
}
