#include "frosty/core.hpp"
#include "frosty/c_api.h"
#include <cassert>
#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
using namespace frosty;
int main(){
 auto p=makeEmptyProject();assert(p.sequences.size()==1);auto&s=p.sequences.front();assert(s.tracks.size()==1);
 Track t;t.id=newId("track");t.name="V2";t.order=1;s.tracks.push_back(t);
 Asset a;a.id=newId("asset");a.path="media/test.mp4";a.name="test.mp4";a.duration=12;p.assets.push_back(a);
 Clip c;c.id=newId("clip");c.assetId=a.id;c.name=a.name;c.trackId=s.tracks[0].id;c.sourceIn=0;c.sourceOut=10;c.timelineStart=0;s.clips.push_back(c);
 Clip c2=c;c2.id=newId("clip");c2.trackId=t.id;c2.timelineStart=12;s.clips.push_back(c2);
 auto report=validateAndRepair(p,false);assert(!report.hasErrors());
 // Edit modes preserve source ranges and remain undoable.
 auto pInsert=p;assert(applyTimelineEdit(pInsert,s.id,EditKind::InsertGap,3,5).ok);assert(pInsert.sequences[0].clips.size()==3);assert(pInsert.sequences[0].clips[1].timelineStart==5);
 auto pOverwrite=p;assert(applyTimelineEdit(pOverwrite,s.id,EditKind::Overwrite,2,4).ok);
 // A clip that begins inside the removed range but continues after it keeps its ID and does not retain a dangling link.
 auto splitCase=makeEmptyProject();auto& splitSeq=splitCase.sequences.front();Clip spanning;spanning.id="keep-right-id";spanning.trackId=splitSeq.tracks.front().id;spanning.sourceIn=0;spanning.sourceOut=8;spanning.timelineStart=2;splitSeq.clips.push_back(spanning);auto splitResult=applyTimelineEdit(splitCase,splitSeq.id,EditKind::RippleDelete,0,4);assert(splitResult.ok);assert(splitCase.sequences[0].clips.size()==1);assert(splitCase.sequences[0].clips[0].id=="keep-right-id");assert(!splitCase.sequences[0].clips[0].linkedClipId);assert(std::abs(splitCase.sequences[0].clips[0].sourceIn-2.0)<1e-9);assert(!validateAndRepair(splitCase,false).hasErrors());
 TimelineCommand overwrite;overwrite.kind=CommandKind::TimelineEdit;overwrite.editKind=EditKind::Overwrite;overwrite.sequenceId=s.id;overwrite.start=2;overwrite.replacement=c;overwrite.replacement->id=newId("replacement");overwrite.replacement->sourceIn=0;overwrite.replacement->sourceOut=2;overwrite.replacement->trackId=s.tracks[0].id;auto pWithOverwrite=p;assert(applyCommand(pWithOverwrite,overwrite).ok);assert(std::any_of(pWithOverwrite.sequences[0].clips.begin(),pWithOverwrite.sequences[0].clips.end(),[&](const Clip&x){return x.id==overwrite.replacement->id;}));
 // Locked tracks reject a transaction without partial state mutation.
 auto locked=p;locked.sequences[0].tracks[1].locked=true;auto before=locked.sequences[0].clips[1].timelineStart;auto denied=applyTimelineEdit(locked,s.id,EditKind::RippleDelete,11,13);assert(!denied.ok);assert(locked.sequences[0].clips[1].timelineStart==before);
 TimelineCommand move;move.kind=CommandKind::MoveClip;move.sequenceId=s.id;move.entityId=c.id;move.start=7;assert(applyCommand(p,move).ok);assert(p.sequences[0].clips[0].timelineStart==7);
 p=makeEmptyProject();auto& hs=p.sequences[0];Track ht;ht.id=newId("track");ht.name="V2";ht.order=1;hs.tracks.push_back(ht);Asset ha;ha.id=newId("asset");ha.path="media/test.mp4";ha.duration=12;p.assets.push_back(ha);Clip hc;hc.id=newId("clip");hc.assetId=ha.id;hc.trackId=hs.tracks[0].id;hc.sourceOut=10;hs.clips.push_back(hc);Clip hc2=hc;hc2.id=newId("clip");hc2.trackId=ht.id;hc2.timelineStart=12;hs.clips.push_back(hc2);CommandHistory h;assert(h.execute(p,hs.id,EditKind::RippleDelete,2,4));assert(h.undoCount()==1);assert(h.undo(p));assert(p.sequences[0].clips.size()==2);assert(h.redo(p));assert(p.sequences[0].clips.size()>=2);
 auto dir=std::filesystem::temp_directory_path()/"frosty-core-phase1-test";std::filesystem::remove_all(dir);std::filesystem::create_directories(dir);auto file=dir/"roundtrip.frosty";saveProjectAtomic(p,file);ValidationReport loadedReport;auto loaded=loadProject(file,&loadedReport);{std::ifstream json(file);std::string raw((std::istreambuf_iterator<char>(json)),{});assert(raw.find("\"schemaVersion\": 2")!=std::string::npos);assert(raw.find("\"width\": 1920")!=std::string::npos);}assert(loaded.schemaVersion==ProjectSchemaVersion);assert(loaded.sequences.size()==1);assert(loaded.sequences[0].clips.size()==p.sequences[0].clips.size());
 // Legacy v1 project fixture: sequential video and overlays must migrate to a native sequence.
 auto legacy=dir/"legacy.frosty";{std::ofstream f(legacy);f<<R"({"mode":"sequential","width":1280,"height":720,"fps":25,"video":[{"id":"old-c1","src":"old.mp4","name":"old.mp4","in":0,"out":5,"speed":1},{"id":"old-c2","src":"old2.mp4","name":"old2.mp4","in":0,"out":4,"speed":1}],"layers":[{"id":"old-l1","src":"overlay.png","name":"overlay.png","in":0,"out":2,"start":1,"track":2}],"audio":[{"id":"old-a1","src":"music.wav","name":"music.wav","in":0,"out":8,"start":0}],"text":[],"trackCount":2,"trackState":{"1":{"name":"V1 Main","visible":true,"muted":false,"locked":false},"2":{"name":"V2 Graphics","visible":false,"muted":true,"locked":true}}})";}
 // Real Electron project envelope must import assets, the root timeline, media lanes, and saved sequences.
 auto electronProject=dir/"electron-wrapper.frosty";{std::ofstream f(electronProject);f<<R"({"tl":{"mode":"free","settings":{"width":1280,"height":720,"frameRate":{"numerator":30000,"denominator":1001}},"trackCount":3,"trackState":{"1":{"name":"V1 Main","visible":true},"2":{"name":"V2 Overlay","visible":false}},"video":[{"id":"ev1","src":"/media/main.mp4","name":"main.mp4","type":"video","in":1,"out":6,"speed":1,"start":2,"track":1,"volume":0.8,"transform":{"alpha":0.9},"fx":{"brightness":0.2}}],"layers":[{"id":"el1","src":"/media/overlay.png","name":"overlay.png","type":"image","in":0,"out":3,"speed":1,"start":1,"track":2}],"audio":[{"id":"ea1","src":"/media/music.wav","name":"music.wav","type":"audio","in":0,"out":9,"speed":1,"start":0,"volume":0.4}],"text":[{"id":"et1","name":"Title","type":"text","text":"Hello","start":0.5,"dur":2,"track":1}],"music":{"src":"/media/bgm.wav","volume":0.2,"duck":true}},"media":[{"path":"/media/main.mp4","name":"main.mp4","type":"video","duration":20,"hasAudio":true},{"path":"/media/overlay.png","name":"overlay.png","type":"image","duration":0},{"path":"/media/music.wav","name":"music.wav","type":"audio","duration":10}],"sequences":{"seq-demo":{"id":"seq-demo","name":"Reusable","mode":"free","settings":{"width":640,"height":360,"frameRate":{"numerator":25,"denominator":1}},"trackCount":2,"video":[{"id":"es1","src":"/media/main.mp4","name":"main.mp4","type":"video","in":0,"out":4,"speed":1,"start":0,"track":1}],"layers":[],"audio":[],"text":[]}}})";}
 auto electronImported=loadProject(electronProject);assert(electronImported.sequences.size()==2);assert(electronImported.activeSequenceId=="root");assert(electronImported.assets.size()==3);auto rootImported=std::find_if(electronImported.sequences.begin(),electronImported.sequences.end(),[](const Sequence&x){return x.id=="root";});assert(rootImported!=electronImported.sequences.end());assert(rootImported->clips.size()==4);assert(std::any_of(rootImported->clips.begin(),rootImported->clips.end(),[](const Clip&x){return x.id=="ev1"&&x.assetId.size()>0&&std::abs(x.timelineStart-2)<1e-6&&std::abs(x.volume-0.8)<1e-6;}));assert(std::any_of(rootImported->clips.begin(),rootImported->clips.end(),[](const Clip&x){return x.id=="et1"&&x.mediaType=="text"&&std::abs(x.sourceOut-2)<1e-6;}));assert(std::any_of(rootImported->clips.begin(),rootImported->clips.end(),[](const Clip&x){return x.id=="ea1"&&x.trackId.size()>0&&std::abs(x.volume-0.4)<1e-6;}));assert(std::any_of(rootImported->tracks.begin(),rootImported->tracks.end(),[](const Track&x){return x.type=="audio";}));assert(electronImported.legacySourceJson.find("\"music\"")!=std::string::npos);auto electronCanonical=dir/"electron-canonical.frosty";saveProjectAtomic(electronImported,electronCanonical);auto electronAgain=loadProject(electronCanonical);assert(electronAgain.sequences.size()==2&&electronAgain.sequences.front().clips.size()==4);assert(electronAgain.legacySourceJson.find("\"tl\"")!=std::string::npos);
 auto future=dir/"future.frosty";{std::ofstream f(future);f<<R"({"schemaVersion":999,"id":"future-project","sequences":[]})";}bool futureRejected=false;try{(void)loadProject(future);}catch(const std::runtime_error&){futureRejected=true;}assert(futureRejected);
 auto migrated=loadProject(legacy);assert(migrated.sequences.size()==1);assert(migrated.sequences[0].clips.size()==4);assert(std::abs(migrated.sequences[0].clips[1].timelineStart-5.0)<0.001);assert(migrated.settings.width==1280&&migrated.settings.frameRate.numerator==25);assert(migrated.settings.timebaseNumerator==1&&migrated.settings.timebaseDenominator==25);assert(std::any_of(migrated.sequences[0].tracks.begin(),migrated.sequences[0].tracks.end(),[](const Track&t){return t.type=="audio";}));assert(std::any_of(migrated.sequences[0].tracks.begin(),migrated.sequences[0].tracks.end(),[](const Track&t){return t.name=="V2 Graphics"&&!t.visible&&t.muted&&t.locked;}));assert(!migrated.legacyPayload.empty());assert(migrated.legacySourceJson.find("\"fps\":25")!=std::string::npos);auto migratedFile=dir/"migrated.frosty";saveProjectAtomic(migrated,migratedFile);auto again=loadProject(migratedFile);assert(again.sequences[0].clips.size()==4);assert(again.legacySourceJson.find("\"fps\":25")!=std::string::npos);
 // Repair invalid settings, ranges, and duplicate IDs conservatively before persistence.
 auto invalid=makeEmptyProject();invalid.settings.width=0;invalid.settings.frameRate.denominator=0;invalid.settings.audioChannels=0;auto& invalidSeq=invalid.sequences.front();Clip bad;bad.id="duplicate";bad.trackId=invalidSeq.tracks.front().id;bad.sourceIn=4;bad.sourceOut=2;bad.opacity=2;invalidSeq.clips.push_back(bad);Clip duplicate=bad;duplicate.id="duplicate";duplicate.sourceIn=0;duplicate.sourceOut=1;invalidSeq.clips.push_back(duplicate);auto repairReport=validateAndRepair(invalid,true);assert(repairReport.repaired>=5);assert(invalid.settings.width>0&&invalid.settings.frameRate.denominator>0&&invalid.settings.audioChannels>0);assert(invalid.sequences[0].clips[0].id!=invalid.sequences[0].clips[1].id);assert(invalid.sequences[0].clips[0].sourceOut>=invalid.sequences[0].clips[0].sourceIn);
 // Group and transition identities survive canonical serialization and validation.
 auto structured=makeEmptyProject();auto& structuredSeq=structured.sequences.front();Clip left;left.id=newId("clip");left.trackId=structuredSeq.tracks.front().id;left.sourceOut=2;left.name="Left";Clip right=left;right.id=newId("clip");right.timelineStart=1.5;right.name="Right";structuredSeq.clips={left,right};Group group;group.id=newId("group");group.name="Pair";group.clipIds={left.id,right.id};structuredSeq.groups.push_back(group);Transition tr;tr.id=newId("transition");tr.fromClipId=left.id;tr.toClipId=right.id;tr.trackId=left.trackId;tr.start=1.5;tr.duration=0.5;structuredSeq.transitions.push_back(tr);assert(!validateAndRepair(structured,false).hasErrors());auto structuredFile=dir/"structured.frosty";saveProjectAtomic(structured,structuredFile);auto structuredAgain=loadProject(structuredFile);assert(structuredAgain.sequences[0].groups.size()==1);assert(structuredAgain.sequences[0].groups[0].clipIds.size()==2);assert(structuredAgain.sequences[0].transitions.size()==1);
 // Test newly added keyframe evaluation in core engine & C ABI
 Clip kclip;kclip.id="kclip";
 Keyframe k1;k1.id="k1";k1.property="rotation";k1.time=0.0;k1.value=0.0;k1.interpolation="linear";
 Keyframe k2;k2.id="k2";k2.property="rotation";k2.time=10.0;k2.value=100.0;k2.interpolation="smoothstep";
 kclip.keyframes.push_back(k1);kclip.keyframes.push_back(k2);
 assert(std::abs(evaluateKeyframe(kclip,"rotation",0.0,0.0)-0.0)<1e-6);
 assert(std::abs(evaluateKeyframe(kclip,"rotation",10.0,0.0)-100.0)<1e-6);
 assert(std::abs(evaluateKeyframe(kclip,"rotation",5.0,0.0)-50.0)<1e-6); // linear 0..10
 assert(std::abs(evaluateKeyframe(kclip,"opacity",5.0,1.0)-1.0)<1e-6); // fallback default

 // C ABI operations used by the WPF application are wired to the same command history.
 auto handle=frosty_project_create();assert(handle!=nullptr);char error[512]{};assert(frosty_project_add_track(handle,"A1","audio",error,sizeof(error))==1);auto apiJson=std::string(frosty_project_json(handle));assert(apiJson.find("A1")!=std::string::npos);assert(frosty_project_undo(handle)==1);assert(std::string(frosty_project_json(handle)).find("A1")==std::string::npos);assert(frosty_project_redo(handle)==1);
 frosty_project_destroy(handle);

 handle = frosty_project_create();
 auto hJson = std::string(frosty_project_json(handle));
 std::size_t idPos = hJson.find("\"id\": \"track-");
 assert(idPos != std::string::npos);
 std::string hTrackId = hJson.substr(idPos + 7, hJson.find("\"", idPos + 7) - (idPos + 7));
 auto dummyMedia = dir/"asset-for-c-api.mp4"; { std::ofstream media(dummyMedia, std::ios::binary); media << "test media placeholder for metadata API"; }
 char assetId[256]{};
 assert(frosty_project_add_asset(handle, dummyMedia.string().c_str(), "TestAsset", "video", 30.0, assetId, sizeof(assetId), error, sizeof(error)) == 1);
 assert(std::string(assetId).rfind("asset-", 0) == 0);
 assert(frosty_project_add_clip(handle, hTrackId.c_str(), "missing-asset", "RejectedClip", 0.0, 0.0, 5.0, error, sizeof(error)) == 0);
 assert(frosty_project_add_clip(handle, hTrackId.c_str(), assetId, "TestClip", 0.0, 0.0, 5.0, error, sizeof(error)) == 1);
 auto clipJson = std::string(frosty_project_json(handle));
 assert(clipJson.find("TestClip") != std::string::npos);
 std::size_t clipIdPos = clipJson.find("\"id\": \"clip-");
 assert(clipIdPos != std::string::npos);
 std::string hClipId = clipJson.substr(clipIdPos + 7, clipJson.find("\"", clipIdPos + 7) - (clipIdPos + 7));
 assert(frosty_project_set_clip_range(handle, hClipId.c_str(), 0.0, 31.0, error, sizeof(error)) == 0);
 assert(frosty_project_set_clip_range(handle, hClipId.c_str(), 1.0, 10.0, error, sizeof(error)) == 1);

 assert(frosty_project_set_clip_volume(handle, hClipId.c_str(), 1.5, error, sizeof(error)) == 1);
 assert(std::string(frosty_project_json(handle)).find("1.5") != std::string::npos);
 const char* staticMask = R"({"enabled":true,"shape":"bezier","invert":false,"feather":2,"nodes":[{"x":0.5,"y":0.1,"in":{"x":0.3,"y":0.1},"out":{"x":0.7,"y":0.1}},{"x":0.9,"y":0.5,"in":{"x":0.9,"y":0.3},"out":{"x":0.9,"y":0.7}},{"x":0.5,"y":0.9,"in":{"x":0.7,"y":0.9},"out":{"x":0.3,"y":0.9}},{"x":0.1,"y":0.5,"in":{"x":0.1,"y":0.7},"out":{"x":0.1,"y":0.3}}],"pathKeyframes":[]})";
 assert(frosty_project_set_clip_mask_json(handle, hClipId.c_str(), staticMask, error, sizeof(error)) == 1);
 auto staticMaskJson = std::string(frosty_project_json(handle)); assert(staticMaskJson.find("\"pathKeyframes\": []") != std::string::npos); assert(staticMaskJson.find("\"invert\": false") != std::string::npos); assert(staticMaskJson.find("\"feather\": 2") != std::string::npos);
 assert(frosty_project_undo(handle) == 1); assert(std::string(frosty_project_json(handle)).find("pathKeyframes") == std::string::npos);
 const char* bezierMask = R"({"enabled":true,"shape":"bezier","invert":false,"feather":2,"nodes":[{"x":0.5,"y":0.1,"in":{"x":0.3,"y":0.1},"out":{"x":0.7,"y":0.1}},{"x":0.9,"y":0.5,"in":{"x":0.9,"y":0.3},"out":{"x":0.9,"y":0.7}},{"x":0.5,"y":0.9,"in":{"x":0.7,"y":0.9},"out":{"x":0.3,"y":0.9}},{"x":0.1,"y":0.5,"in":{"x":0.1,"y":0.7},"out":{"x":0.1,"y":0.3}}],"pathKeyframes":[{"t":0,"interpolation":"linear","nodes":[{"x":0.3,"y":0.1,"in":{"x":0.2,"y":0.1},"out":{"x":0.4,"y":0.1}},{"x":0.7,"y":0.5,"in":{"x":0.7,"y":0.3},"out":{"x":0.7,"y":0.7}},{"x":0.3,"y":0.9,"in":{"x":0.4,"y":0.9},"out":{"x":0.2,"y":0.9}},{"x":0.1,"y":0.5,"in":{"x":0.1,"y":0.7},"out":{"x":0.1,"y":0.3}}]},{"t":1,"interpolation":"bezier","nodes":[{"x":0.4,"y":0.1,"in":{"x":0.3,"y":0.1},"out":{"x":0.5,"y":0.1}},{"x":0.8,"y":0.5,"in":{"x":0.8,"y":0.3},"out":{"x":0.8,"y":0.7}},{"x":0.4,"y":0.9,"in":{"x":0.5,"y":0.9},"out":{"x":0.3,"y":0.9}},{"x":0.1,"y":0.5,"in":{"x":0.1,"y":0.7},"out":{"x":0.1,"y":0.3}}]}]})";
 assert(frosty_project_set_clip_mask_json(handle, hClipId.c_str(), bezierMask, error, sizeof(error)) == 1);
 std::string duplicateMaskTimes = bezierMask; auto secondMaskKeyTime = duplicateMaskTimes.find("\"t\":1"); assert(secondMaskKeyTime != std::string::npos); duplicateMaskTimes.replace(secondMaskKeyTime, 5, "\"t\":0"); assert(frosty_project_set_clip_mask_json(handle, hClipId.c_str(), duplicateMaskTimes.c_str(), error, sizeof(error)) == 0);
 auto maskJson = std::string(frosty_project_json(handle)); assert(maskJson.find("bezier") != std::string::npos); assert(maskJson.find("pathKeyframes") != std::string::npos);
 assert(frosty_project_undo(handle) == 1); assert(std::string(frosty_project_json(handle)).find("pathKeyframes") == std::string::npos);
 assert(frosty_project_redo(handle) == 1); assert(std::string(frosty_project_json(handle)).find("pathKeyframes") != std::string::npos);
 assert(frosty_project_set_clip_mask_json(handle, hClipId.c_str(), R"({"shape":"bezier","nodes":[{"x":2,"y":0,"in":{"x":0,"y":0},"out":{"x":0,"y":0}}]})", error, sizeof(error)) == 0);

 assert(frosty_project_set_clip_effect(handle, hClipId.c_str(), "brightness", "value", 0.1, 1, error, sizeof(error)) == 1);
 auto effectJson = std::string(frosty_project_json(handle)); assert(effectJson.find("brightness") != std::string::npos); assert(effectJson.find("0.1") != std::string::npos);
 assert(frosty_project_undo(handle) == 1); assert(std::string(frosty_project_json(handle)).find("brightness") == std::string::npos);
 assert(frosty_project_redo(handle) == 1);
 assert(frosty_project_set_clip_keyframe(handle, hClipId.c_str(), "rotation", 0.0, 0.0, "linear", error, sizeof(error)) == 1);
 assert(frosty_project_set_clip_keyframe(handle, hClipId.c_str(), "rotation", 10.0, 100.0, "linear", error, sizeof(error)) == 1);
 assert(std::abs(frosty_project_evaluate_keyframe(handle, hClipId.c_str(), "rotation", 5.0, 0.0) - 50.0) < 1e-6);
 // Batched visual-timeline split edits are atomic, preserve source continuity, and remain undoable.
 const auto splitOps = std::string("[{\"op\":\"split\",\"clipId\":\"") + hClipId + "\",\"start\":5}]";
 assert(frosty_project_apply_clip_edits_json(handle, splitOps.c_str(), error, sizeof(error)) == 1);
 auto splitJson = std::string(frosty_project_json(handle));
 assert(splitJson.find("\"timelineStart\": 5") != std::string::npos);
 assert(splitJson.find("\"sourceIn\": 6") != std::string::npos);
 assert(frosty_project_undo(handle) == 1);
 assert(std::string(frosty_project_json(handle)).find("\"timelineStart\": 5") == std::string::npos);
 assert(frosty_project_redo(handle) == 1);
 assert(std::string(frosty_project_json(handle)).find("\"timelineStart\": 5") != std::string::npos);
 // Native visual-inspector properties cover playback, opacity, volume, enabled state, and nested transforms.
 std::string propertyOps = "[";
 auto appendProperty = [&](const std::string& property, const std::string& value) {
  if (propertyOps.size() > 1) propertyOps += ",";
  propertyOps += "{\"op\":\"property\",\"clipId\":\"" + hClipId + "\",\"property\":\"" + property + "\",\"value\":" + value + "}";
 };
 appendProperty("name", "\"Timeline clip renamed\""); appendProperty("enabled", "false");
 appendProperty("playbackRate", "2"); appendProperty("opacity", "0.75"); appendProperty("volume", "1.25");
 appendProperty("transform.x", "0.25"); appendProperty("transform.scaleX", "1.5"); appendProperty("transform.shearY", "0.1");
 propertyOps += "]";
 assert(frosty_project_apply_clip_edits_json(handle, propertyOps.c_str(), error, sizeof(error)) == 1);
 auto propertyJson = std::string(frosty_project_json(handle));
 assert(propertyJson.find("Timeline clip renamed") != std::string::npos);
 assert(propertyJson.find("\"enabled\": false") != std::string::npos);
 assert(propertyJson.find("\"playbackRate\": 2") != std::string::npos);
 assert(propertyJson.find("\"opacity\": 0.75") != std::string::npos);
 assert(propertyJson.find("\"volume\": 1.25") != std::string::npos);
 assert(propertyJson.find("\"scaleX\": 1.5") != std::string::npos);
 assert(propertyJson.find("\"shearY\": 0.1") != std::string::npos);
 assert(frosty_project_undo(handle) == 1);
 auto undonePropertyJson = std::string(frosty_project_json(handle));
 assert(undonePropertyJson.find("Timeline clip renamed") == std::string::npos);
 assert(undonePropertyJson.find("\"playbackRate\": 2") == std::string::npos);
 // A batch is transactional: if a later property is invalid, earlier changes are rolled back.
 const auto invalidBatch = std::string("[{\"op\":\"move\",\"clipId\":\"") + hClipId + "\",\"start\":3},{\"op\":\"property\",\"clipId\":\"" + hClipId + "\",\"property\":\"transform.scaleX\",\"value\":20}]";
 assert(frosty_project_apply_clip_edits_json(handle, invalidBatch.c_str(), error, sizeof(error)) == 0);
 auto afterRejectedBatch = std::string(frosty_project_json(handle));
 assert(afterRejectedBatch.find("\"timelineStart\": 3") == std::string::npos);
 assert(afterRejectedBatch.find("\"scaleX\": 20") == std::string::npos);
 assert(frosty_project_set_clip_keyframe(handle, "non-existent", "scale", 0.0, 1.0, "linear", error, sizeof(error)) == 0);
 assert(std::string(frosty_project_validation(handle)).find("\"valid\":true")!=std::string::npos);frosty_project_destroy(handle);
 auto snap=dir/"recovery";saveRecoverySnapshot(again,snap,3);auto recovered=recoverLatestSnapshot(snap);assert(recovered.id==again.id);
 std::cout<<"Phase 1 core tests passed\n";std::filesystem::remove_all(dir);return 0;
}
