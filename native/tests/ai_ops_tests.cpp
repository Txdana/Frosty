#include "frosty/c_api.h"
#include <boost/property_tree/json_parser.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <chrono>
#include <array>
#include <cmath>
#include <sstream>

namespace {
void require(bool condition, const std::string& message) { if (!condition) throw std::runtime_error(message); }
boost::property_tree::ptree parseJson(const char* text) { std::istringstream input(text ? text : "{}"); boost::property_tree::ptree tree; boost::property_tree::read_json(input, tree); return tree; }
std::string stringValue(const boost::property_tree::ptree& tree, const std::string& key) { return tree.get<std::string>(key, ""); }
std::string clipIdByName(const boost::property_tree::ptree& root, const std::string& name) {
  const auto& sequences = root.get_child("sequences");
  for (const auto& sequence : sequences) for (const auto& item : sequence.second.get_child("clips")) if (stringValue(item.second,"name") == name) return stringValue(item.second,"id");
  return {};
}
}
int main() {
  frosty_project_handle project = nullptr;
  const auto path = std::filesystem::temp_directory_path() / ("frosty-ai-ops-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".mp4");
  try {
    { std::ofstream file(path, std::ios::binary); file << "test asset placeholder"; }
    std::array<char, 128> error{}, assetId{};
    project = frosty_project_create(); require(project != nullptr, "native project creation failed");
    auto before = parseJson(frosty_project_json(project));
    const auto trackId = stringValue(before.get_child("sequences").front().second.get_child("tracks").front().second,"id");
    require(!trackId.empty(), "default track ID missing");
    require(frosty_project_add_asset(project,path.string().c_str(),"Test media","video",12,assetId.data(),static_cast<int>(assetId.size()),error.data(),static_cast<int>(error.size()))==1,"asset add failed: "+std::string(error.data()));
    require(frosty_project_add_clip(project,trackId.c_str(),assetId.data(),"First shot",0,0,8,error.data(),static_cast<int>(error.size()))==1,"first clip add failed: "+std::string(error.data()));
    require(frosty_project_add_clip(project,trackId.c_str(),assetId.data(),"Second shot",8,2,10,error.data(),static_cast<int>(error.size()))==1,"second clip add failed: "+std::string(error.data()));
    auto populated = parseJson(frosty_project_json(project));
    const auto first = clipIdByName(populated,"First shot"), second = clipIdByName(populated,"Second shot");
    require(!first.empty()&&!second.empty(),"clip IDs missing after asset import");
    const std::string batch = "["
      "{\"op\":\"move\",\"clipId\":\""+first+"\",\"start\":2},"
      "{\"op\":\"range\",\"clipId\":\""+first+"\",\"sourceIn\":1,\"sourceOut\":7},"
      "{\"op\":\"property\",\"clipId\":\""+first+"\",\"property\":\"playbackRate\",\"value\":1.5},"
      "{\"op\":\"property\",\"clipId\":\""+first+"\",\"property\":\"opacity\",\"value\":0.65},"
      "{\"op\":\"property\",\"clipId\":\""+first+"\",\"property\":\"transform.x\",\"value\":0.25},"
      "{\"op\":\"keyframe\",\"clipId\":\""+first+"\",\"property\":\"rotation\",\"time\":1,\"value\":15,\"interpolation\":\"bezier\"},"
      "{\"op\":\"effect\",\"clipId\":\""+first+"\",\"type\":\"brightness\",\"parameter\":\"value\",\"value\":0.2,\"enabled\":true},"
      "{\"op\":\"transition\",\"transitionId\":\"ai-transition-test\",\"type\":\"crossfade\",\"trackId\":\""+trackId+"\",\"fromClipId\":\""+first+"\",\"toClipId\":\""+second+"\",\"start\":7,\"duration\":0.5,\"audio\":false},"
      "{\"op\":\"track_state\",\"trackId\":\""+trackId+"\",\"property\":\"muted\",\"value\":true}"
      "]";
    require(frosty_project_apply_clip_edits_json(project,batch.c_str(),error.data(),static_cast<int>(error.size()))==1,"native AI edit batch failed: "+std::string(error.data()));
    const std::string changed = frosty_project_json(project);
    auto after = parseJson(changed.c_str());
    bool sawFirst=false; for(const auto& seq:after.get_child("sequences")) for(const auto& pair:seq.second.get_child("clips")) if(stringValue(pair.second,"id")==first){sawFirst=true;require(std::abs(pair.second.get<double>("timelineStart")-2.0)<1e-6,"move not applied");require(std::abs(pair.second.get<double>("playbackRate")-1.5)<1e-6,"speed property not applied");require(std::abs(pair.second.get<double>("opacity")-0.65)<1e-6,"opacity property not applied");require(std::abs(pair.second.get<double>("legacyFields.transform.x")-0.25)<1e-6,"transform property not applied");require(pair.second.get_child("keyframes").size()==1,"keyframe not applied");require(pair.second.get_child("effects").size()==1,"effect not applied");}
    require(sawFirst,"edited clip not found");
    require(after.get_child("sequences").front().second.get_child("transitions").size()==1,"transition not applied");
    require(after.get_child("sequences").front().second.get_child("tracks").front().second.get<bool>("muted"),"track state not applied");

    // AI may place an existing asset and then create a gap; both actions remain one undoable batch.
    const std::string mediaBatch = "["
      "{\"op\":\"add_clip\",\"trackId\":\""+trackId+"\",\"assetId\":\""+std::string(assetId.data())+"\",\"name\":\"Third shot\",\"start\":15,\"sourceIn\":0,\"sourceOut\":2},"
      "{\"op\":\"timeline_edit\",\"editKind\":\"insert_gap\",\"start\":12,\"end\":13}"
      "]";
    require(frosty_project_apply_clip_edits_json(project,mediaBatch.c_str(),error.data(),static_cast<int>(error.size()))==1,"asset placement/timeline edit batch failed: "+std::string(error.data()));
    auto mediaTree=parseJson(frosty_project_json(project)); bool thirdFound=false;
    for(const auto& seq:mediaTree.get_child("sequences")) for(const auto& pair:seq.second.get_child("clips")) if(stringValue(pair.second,"name")=="Third shot"){thirdFound=true;require(std::abs(pair.second.get<double>("timelineStart")-16.0)<1e-6,"inserted gap did not ripple the newly added clip");}
    require(thirdFound,"AI add_clip operation did not create the requested clip");

    // Invalid later commands must roll back earlier valid edits in the same AI plan.
    const std::string invalidBatch = "[{\"op\":\"volume\",\"clipId\":\""+first+"\",\"value\":2},{\"op\":\"property\",\"clipId\":\""+first+"\",\"property\":\"playbackRate\",\"value\":0.001}]";
    require(frosty_project_apply_clip_edits_json(project,invalidBatch.c_str(),error.data(),static_cast<int>(error.size()))==0,"invalid batch unexpectedly succeeded");
    const std::string rolledBack = frosty_project_json(project); auto rollbackTree=parseJson(rolledBack.c_str());
    for(const auto& seq:rollbackTree.get_child("sequences")) for(const auto& pair:seq.second.get_child("clips")) if(stringValue(pair.second,"id")==first){require(std::abs(pair.second.get<double>("volume",1)-1.0)<1e-6,"failed transaction did not roll back the earlier volume edit");require(std::abs(pair.second.get<double>("playbackRate")-1.5)<1e-6,"failed transaction changed playback speed");}
    // Planner integration can create a track, configure its numeric mixer state, add a clip to it,
    // and apply a validated mask in the same atomic command batch.
    const std::string trackAndMaskBatch = "["
      "{\"op\":\"add_track\",\"trackId\":\"ai-track-test\",\"name\":\"AI B-roll\",\"type\":\"video\"},"
      "{\"op\":\"track_state\",\"trackId\":\"ai-track-test\",\"property\":\"gain\",\"value\":0.75},"
      "{\"op\":\"track_state\",\"trackId\":\"ai-track-test\",\"property\":\"opacity\",\"value\":0.8},"
      "{\"op\":\"add_clip\",\"trackId\":\"ai-track-test\",\"assetId\":\""+std::string(assetId.data())+"\",\"name\":\"AI B-roll clip\",\"start\":20,\"sourceIn\":0,\"sourceOut\":2},"
      "{\"op\":\"mask\",\"clipId\":\""+first+"\",\"mask\":{\"shape\":\"rectangle\",\"x\":0.1,\"y\":0.1,\"width\":0.8,\"height\":0.8}}"
      "]";
    require(frosty_project_apply_clip_edits_json(project,trackAndMaskBatch.c_str(),error.data(),static_cast<int>(error.size()))==1,"AI track/mask batch failed: "+std::string(error.data()));
    auto trackMaskTree=parseJson(frosty_project_json(project)); bool trackAdded=false, maskSaved=false, clipAddedToNewTrack=false;
    for(const auto& seq:trackMaskTree.get_child("sequences")) {
      for(const auto& tr:seq.second.get_child("tracks")) if(stringValue(tr.second,"id")=="ai-track-test") {trackAdded=true;require(std::abs(tr.second.get<double>("gain")-0.75)<1e-6,"AI track gain not applied");require(std::abs(tr.second.get<double>("opacity")-0.8)<1e-6,"AI track opacity not applied");}
      for(const auto& cl:seq.second.get_child("clips")) {if(stringValue(cl.second,"name")=="AI B-roll clip") {clipAddedToNewTrack=true;require(stringValue(cl.second,"trackId")=="ai-track-test","new clip not placed on AI-created track");}if(stringValue(cl.second,"id")==first)maskSaved=cl.second.get<std::string>("legacyFields.mask.shape","")=="rectangle";}
    }
    require(trackAdded&&clipAddedToNewTrack&&maskSaved,"AI track creation, placement or mask persistence missing");

    const std::string removeTransition = "[{\"op\":\"remove_transition\",\"transitionId\":\"ai-transition-test\"}]";
    require(frosty_project_apply_clip_edits_json(project,removeTransition.c_str(),error.data(),static_cast<int>(error.size()))==1,"transition removal failed: "+std::string(error.data()));
    auto afterRemove = parseJson(frosty_project_json(project)); require(afterRemove.get_child("sequences").front().second.get_child("transitions").empty(),"transition removal did not persist");
    std::cout << "native AI operations integration tests passed (clip edits, transforms, keyframes, effects, masks, track creation/mixer state, transitions and atomic rollback)\n";
    frosty_project_destroy(project); project=nullptr; std::filesystem::remove(path); return 0;
  } catch (const std::exception& error) {
    std::cerr << "native AI operations integration test failed: " << error.what() << '\n';
    if(project) frosty_project_destroy(project); std::error_code ec;std::filesystem::remove(path,ec);return 1;
  }
}
