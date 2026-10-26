#pragma once
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>
#include <boost/property_tree/ptree.hpp>
namespace frosty {
inline constexpr int ProjectSchemaVersion = 2;
struct Rational { int numerator{30}; int denominator{1}; };
struct ProjectSettings { int width{1920},height{1080}; Rational frameRate{}; int timebaseNumerator{1},timebaseDenominator{30}; int pixelAspectNumerator{1},pixelAspectDenominator{1}; int displayAspectNumerator{16},displayAspectDenominator{9}; std::string colorSpace{"bt709"},colorRange{"limited"},colorPrimaries{"bt709"},transferCharacteristics{"bt709"},matrixCoefficients{"bt709"}; int audioSampleRate{48000},audioChannels{2}; std::string audioChannelLayout{"stereo"}; std::string exportContainer{"mp4"},videoCodec{"libx264"},audioCodec{"aac"}; };
struct Asset { std::string id,path,name,mediaType{"video"}; double duration{0}; std::optional<std::string> checksum; bool missing{false}; };
struct Keyframe { std::string id,property,interpolation{"linear"}; double time{0},value{0}; };
struct Effect { std::string id,type; bool enabled{true}; boost::property_tree::ptree parameters; };
struct Clip { std::string id,assetId,name,mediaType{"video"},trackId; double timelineStart{0},sourceIn{0},sourceOut{0},playbackRate{1}; bool enabled{true},linkedAudio{false}; std::optional<std::string> linkedClipId,groupId,nestedSequenceId; double volume{1},opacity{1}; std::vector<Keyframe> keyframes; std::vector<Effect> effects; boost::property_tree::ptree legacyFields; };
struct Track { std::string id,name,type{"video"}; int order{0}; bool muted{false},solo{false},visible{true},locked{false}; double gain{1},opacity{1}; std::optional<std::string> parentTrackId; };
struct Marker { std::string id,name; double time{0}; std::optional<double> duration; };
struct Group { std::string id,name; std::vector<std::string> clipIds; };
struct Transition { std::string id,type{"crossfade"},trackId,fromClipId,toClipId; double start{0},duration{0.5}; bool audio{false}; boost::property_tree::ptree parameters; };
struct Sequence { std::string id,name; ProjectSettings settings; std::vector<Track> tracks; std::vector<Clip> clips; std::vector<Marker> markers; std::vector<Group> groups; std::vector<Transition> transitions; std::vector<std::string> nestedSequenceIds; };
struct Project { std::string id,name{"Untitled"}; int schemaVersion{ProjectSchemaVersion}; ProjectSettings settings; std::vector<Asset> assets; std::vector<Sequence> sequences; std::string activeSequenceId; boost::property_tree::ptree legacyPayload; std::string legacySourceJson; };
struct ValidationIssue { std::string severity,code,message,entityId; };
struct ValidationReport { std::vector<ValidationIssue> issues; int repaired{0}; bool hasErrors() const; };
std::string newId(const std::string& prefix); Project makeEmptyProject();
std::string projectToJson(const Project& project);
ValidationReport validateAndRepair(Project& project,bool repair);
Project loadProject(const std::filesystem::path& path,ValidationReport* report=nullptr);
void saveProjectAtomic(const Project& project,const std::filesystem::path& path);
void saveRecoverySnapshot(const Project& project,const std::filesystem::path& path,std::size_t keep=10);
Project recoverLatestSnapshot(const std::filesystem::path& directory);
double clipDuration(const Clip& clip);
enum class EditKind { RippleDelete,InsertGap,Overwrite };
enum class CommandKind { TimelineEdit, MoveClip, SetClipRange, AddTrack, SetTrackState, RemoveClip };
struct TimelineCommand {
  CommandKind kind{CommandKind::TimelineEdit}; EditKind editKind{EditKind::RippleDelete};
  std::string sequenceId, entityId; double start{0}, end{0};
  std::string text,value; bool flag{false}; int integer{0}; std::optional<Clip> replacement;
};
struct EditResult { bool ok{false}; std::string message; };
EditResult applyTimelineEdit(Project& project,const std::string& sequenceId,EditKind kind,double start,double end);
EditResult applyCommand(Project& project,const TimelineCommand& command);
class CommandHistory { public: explicit CommandHistory(std::size_t limit=100); bool execute(Project&,const std::string&,EditKind,double,double); bool execute(Project&,const TimelineCommand&); bool undo(Project&); bool redo(Project&); std::size_t undoCount()const; std::size_t redoCount()const; private: std::size_t limit_; std::vector<Project> undo_,redo_; };
}
