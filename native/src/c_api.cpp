#include "frosty/c_api.h"
#include "frosty/core.hpp"
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <boost/property_tree/json_parser.hpp>
#include <string>
namespace {
void setError(char* out,int cap,const std::string& message){if(!out||cap<=0)return;const auto n=std::min<std::size_t>(message.size(),static_cast<std::size_t>(cap-1));std::copy_n(message.data(),n,out);out[n]='\0';}
std::string escapeJson(const std::string& value){std::string out;for(unsigned char c:value){switch(c){case '\"':out+="\\\"";break;case '\\':out+="\\\\";break;case '\n':out+="\\n";break;case '\r':out+="\\r";break;case '\t':out+="\\t";break;default:if(c<0x20){std::ostringstream x;x<<"\\u"<<std::hex<<std::setw(4)<<std::setfill('0')<<static_cast<int>(c);out+=x.str();}else out+=static_cast<char>(c);}}return out;}
struct Handle { frosty::Project project; frosty::CommandHistory history; std::string buffer; explicit Handle(frosty::Project p):project(std::move(p)),history(100){} };
Handle* get(frosty_project_handle h){if(!h)throw std::runtime_error("Project handle is null");return static_cast<Handle*>(h);}
std::string activeSeqId(frosty::Project& p){if(p.sequences.empty())throw std::runtime_error("Project has no sequence");return p.activeSequenceId.empty()?p.sequences.front().id:p.activeSequenceId;}
std::string pathUtf8(const std::filesystem::path& value){const auto u=value.u8string();return std::string(reinterpret_cast<const char*>(u.data()),u.size());}
std::filesystem::path pathFromUtf8(const char* value){return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(value)));}
int addAsset(Handle* handle,const std::filesystem::path& input,const char* name,const char* mediaType,double duration,char* idOut,int idCap,char* error,int errorCap){
 try {
  if(input.empty())throw std::runtime_error("Asset path is required");
  std::error_code ec;
  if(!std::filesystem::exists(input,ec)||ec||!std::filesystem::is_regular_file(input,ec)||ec)throw std::runtime_error("Asset file does not exist or is not a regular file");
  if(!std::isfinite(duration)||duration<0)throw std::runtime_error("Asset duration must be a finite non-negative number");
  const std::string kind=mediaType?mediaType:"video";
  if(kind!="video"&&kind!="audio"&&kind!="image")throw std::runtime_error("Media type must be video, audio, or image");
  auto canonical=std::filesystem::weakly_canonical(input,ec);if(ec)canonical=std::filesystem::absolute(input,ec).lexically_normal();if(ec)throw std::runtime_error("Could not normalize asset path");
  const std::string storedPath=pathUtf8(canonical);
  for(const auto& existing:handle->project.assets){if(existing.path==storedPath){setError(idOut,idCap,existing.id);return 1;}}
  frosty::Asset asset;asset.id=frosty::newId("asset");asset.path=storedPath;asset.name=name&&*name?name:pathUtf8(input.filename());asset.mediaType=kind;asset.duration=duration;asset.missing=false;
  handle->project.assets.push_back(asset);
  setError(idOut,idCap,asset.id);
  return 1;
 }catch(const std::exception& e){setError(error,errorCap,e.what());return 0;}catch(...){setError(error,errorCap,"Unknown asset import error");return 0;}
}
}
extern "C" {
const char* frosty_core_version(void){return "0.2.0-phase1";}
frosty_project_handle frosty_project_create(void){try{return new Handle(frosty::makeEmptyProject());}catch(...){return nullptr;}}
frosty_project_handle frosty_project_load(const char* path,char* error,int cap){try{if(!path)throw std::runtime_error("Project path is null");frosty::ValidationReport report;return new Handle(frosty::loadProject(path,&report));}catch(const std::exception&e){setError(error,cap,e.what());return nullptr;}catch(...){setError(error,cap,"Unknown native engine error");return nullptr;}}
#ifdef _WIN32
frosty_project_handle frosty_project_load_w(const wchar_t* path,char* error,int cap){try{if(!path)throw std::runtime_error("Project path is null");frosty::ValidationReport report;return new Handle(frosty::loadProject(std::filesystem::path(path),&report));}catch(const std::exception&e){setError(error,cap,e.what());return nullptr;}catch(...){setError(error,cap,"Unknown native engine error");return nullptr;}}
#endif
int frosty_project_save(frosty_project_handle h,const char* path,char* error,int cap){try{auto*x=get(h);if(!path)throw std::runtime_error("Project path is null");auto r=frosty::validateAndRepair(x->project,false);if(r.hasErrors())throw std::runtime_error("Project validation failed; save cancelled");frosty::saveProjectAtomic(x->project,path);return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
#ifdef _WIN32
int frosty_project_save_w(frosty_project_handle h,const wchar_t* path,char* error,int cap){try{auto*x=get(h);if(!path)throw std::runtime_error("Project path is null");auto r=frosty::validateAndRepair(x->project,false);if(r.hasErrors())throw std::runtime_error("Project validation failed; save cancelled");frosty::saveProjectAtomic(x->project,std::filesystem::path(path));return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
#endif
const char* frosty_project_summary(frosty_project_handle h){static thread_local std::string result;try{auto*x=get(h);std::ostringstream s;s<<"{\"id\":\""<<escapeJson(x->project.id)<<"\",\"name\":\""<<escapeJson(x->project.name)<<"\",\"schemaVersion\":"<<x->project.schemaVersion<<",\"sequences\":"<<x->project.sequences.size()<<",\"assets\":"<<x->project.assets.size()<<"}";result=s.str();return result.c_str();}catch(...){return "{}";}}
const char* frosty_project_json(frosty_project_handle h){static thread_local std::string result;try{result=frosty::projectToJson(get(h)->project);return result.c_str();}catch(...){return "{}";}}
int frosty_project_add_asset(frosty_project_handle h,const char* path,const char* name,const char* media_type,double duration,char* asset_id,int asset_id_capacity,char* error,int cap){try{if(!path)throw std::runtime_error("Asset path is null");return addAsset(get(h),pathFromUtf8(path),name,media_type,duration,asset_id,asset_id_capacity,error,cap);}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown asset import error");return 0;}}
#ifdef _WIN32
int frosty_project_add_asset_w(frosty_project_handle h,const wchar_t* path,const char* name,const char* media_type,double duration,char* asset_id,int asset_id_capacity,char* error,int cap){try{if(!path)throw std::runtime_error("Asset path is null");return addAsset(get(h),std::filesystem::path(path),name,media_type,duration,asset_id,asset_id_capacity,error,cap);}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown asset import error");return 0;}}
#endif
int frosty_project_add_track(frosty_project_handle h,const char* name,const char* type,char* error,int cap){try{auto*x=get(h);auto& p=x->project;frosty::TimelineCommand c;c.kind=frosty::CommandKind::AddTrack;c.sequenceId=activeSeqId(p);c.text=name?name:"";c.integer=(type&&std::string(type)=="audio")?1:0;if(!x->history.execute(p,c))throw std::runtime_error("Could not add track");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
int frosty_project_set_track_state(frosty_project_handle h,const char* id,const char* property,int value,char* error,int cap){try{auto*x=get(h);if(!id||!property)throw std::runtime_error("Track ID and property are required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::SetTrackState;c.sequenceId=activeSeqId(x->project);c.entityId=id;c.text=property;c.flag=value!=0;if(!x->history.execute(x->project,c))throw std::runtime_error("Track update rejected");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
int frosty_project_add_clip(frosty_project_handle h,const char* track_id,const char* asset_id,const char* name,double start,double in_time,double out_time,char* error,int cap){try{auto*x=get(h);if(!track_id)throw std::runtime_error("Track ID is required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::AddClip;c.sequenceId=activeSeqId(x->project);c.entityId=track_id;c.assetId=asset_id?asset_id:"";c.text=name?name:"";c.start=start;c.time=in_time;c.val=out_time;if(!x->history.execute(x->project,c))throw std::runtime_error("Could not add clip");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
int frosty_project_move_clip(frosty_project_handle h,const char* clip_id,double start,char* error,int cap){try{auto*x=get(h);if(!clip_id)throw std::runtime_error("Clip ID is required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::MoveClip;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;c.start=start;if(!x->history.execute(x->project,c))throw std::runtime_error("Could not move clip");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
int frosty_project_apply_clip_edits_json(frosty_project_handle h,const char* edits_json,char* error,int cap){
 try{
  auto*x=get(h);if(!edits_json)throw std::runtime_error("AI edit JSON is null");
  boost::property_tree::ptree edits;std::istringstream input(edits_json);boost::property_tree::read_json(input,edits);
  const auto sid=activeSeqId(x->project);std::vector<frosty::TimelineCommand> commands;
  auto parseBool=[](const boost::property_tree::ptree& node,const std::string& field,bool fallback=false){return node.get<bool>(field,fallback);};
  for(const auto& entry:edits){const auto& e=entry.second;const auto op=e.get<std::string>("op","");
   frosty::TimelineCommand c;c.sequenceId=sid;
   if(op=="add_track"){
    c.kind=frosty::CommandKind::AddTrack;c.entityId=e.get<std::string>("trackId","");c.text=e.get<std::string>("name","");const auto type=e.get<std::string>("type","video");if(type!="video"&&type!="audio")throw std::runtime_error("AI add_track type must be video or audio");c.integer=type=="audio"?1:0;commands.push_back(std::move(c));continue;
   }
   if(op=="timeline_edit"){
    c.kind=frosty::CommandKind::TimelineEdit;const auto edit=e.get<std::string>("editKind","");
    if(edit=="ripple_delete")c.editKind=frosty::EditKind::RippleDelete;else if(edit=="insert_gap")c.editKind=frosty::EditKind::InsertGap;else throw std::runtime_error("Unsupported AI timeline edit: "+edit);
    c.start=e.get<double>("start");c.end=e.get<double>("end");commands.push_back(std::move(c));continue;
   }
   if(op=="track_state"){
    c.kind=frosty::CommandKind::SetTrackState;c.entityId=e.get<std::string>("trackId","");c.text=e.get<std::string>("property","");
    if(c.entityId.empty()||c.text.empty())throw std::runtime_error("Track state edit requires trackId and property");
    if(c.text=="name")c.value=e.get<std::string>("value","");else if(c.text=="gain"||c.text=="opacity")c.val=e.get<double>("value");else c.flag=parseBool(e,"value");commands.push_back(std::move(c));continue;
   }
   if(op=="transition"){
    c.kind=frosty::CommandKind::SetTransition;c.entityId=e.get<std::string>("transitionId","");c.text=e.get<std::string>("type","");c.assetId=e.get<std::string>("trackId","");c.value=e.get<std::string>("fromClipId","");c.propName=e.get<std::string>("toClipId","");c.start=e.get<double>("start");c.end=e.get<double>("duration");c.flag=parseBool(e,"audio",false);
    commands.push_back(std::move(c));continue;
   }
   if(op=="remove_transition"){
    c.kind=frosty::CommandKind::DeleteTransition;c.entityId=e.get<std::string>("transitionId","");if(c.entityId.empty())throw std::runtime_error("Transition removal requires transitionId");commands.push_back(std::move(c));continue;
   }
   if(op=="mask"){
    c.kind=frosty::CommandKind::SetClipMask;c.entityId=e.get<std::string>("clipId","");if(c.entityId.empty())throw std::runtime_error("Mask edit requires clipId");auto mask=e.get_child_optional("mask");if(!mask)throw std::runtime_error("Mask edit requires a mask object");std::ostringstream encoded;boost::property_tree::write_json(encoded,*mask,false);c.value=encoded.str();commands.push_back(std::move(c));continue;
   }
   if(op=="add_clip"){
    c.kind=frosty::CommandKind::AddClip;c.entityId=e.get<std::string>("trackId","");c.assetId=e.get<std::string>("assetId","");c.text=e.get<std::string>("name","");c.start=e.get<double>("start");c.time=e.get<double>("sourceIn");c.val=e.get<double>("sourceOut");commands.push_back(std::move(c));continue;
   }
   c.entityId=e.get<std::string>("clipId","");if(c.entityId.empty())throw std::runtime_error("Every AI clip edit requires clipId");
   if(op=="move"){c.kind=frosty::CommandKind::MoveClip;c.start=e.get<double>("start");c.text=e.get<std::string>("trackId","");}
   else if(op=="split"){c.kind=frosty::CommandKind::SplitClip;c.start=e.get<double>("start");}
   else if(op=="range"){c.kind=frosty::CommandKind::SetClipRange;c.start=e.get<double>("sourceIn");c.end=e.get<double>("sourceOut");}
   else if(op=="remove"){c.kind=frosty::CommandKind::RemoveClip;}
   else if(op=="volume"){c.kind=frosty::CommandKind::SetClipVolume;c.val=e.get<double>("value");}
   else if(op=="property"){
    c.kind=frosty::CommandKind::SetClipProperty;c.propName=e.get<std::string>("property","");if(c.propName.empty())throw std::runtime_error("Property edit requires property");
    if(c.propName=="name")c.value=e.get<std::string>("value","");else if(c.propName=="enabled")c.flag=parseBool(e,"value");else c.val=e.get<double>("value");
   }
   else if(op=="keyframe"){c.kind=frosty::CommandKind::SetKeyframe;c.propName=e.get<std::string>("property","");c.time=e.get<double>("time");c.val=e.get<double>("value");c.interpolation=e.get<std::string>("interpolation","linear");}
   else if(op=="effect"){c.kind=frosty::CommandKind::SetEffect;c.text=e.get<std::string>("type","");c.propName=e.get<std::string>("parameter","");c.val=e.get<double>("value");c.flag=parseBool(e,"enabled",true);}
   else if(op=="clear_effects"){c.kind=frosty::CommandKind::SetEffect;c.text="clear";}
   else throw std::runtime_error("Unsupported AI clip operation: "+op);
   commands.push_back(std::move(c));
  }
  if(commands.empty())throw std::runtime_error("No AI edit operations were supplied");
  // CommandHistory applies the batch to a working project and rolls every command back if any one fails.
  if(!x->history.execute(x->project,commands))throw std::runtime_error("AI edit batch rejected; no changes were applied. Verify IDs, track lock state, ranges and parameter values.");
  return 1;
 }catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown batched AI edit error");return 0;}
}
int frosty_project_timeline_edit(frosty_project_handle h,const char* operation,double start,double end,char* error,int cap){
 try{auto*x=get(h);if(!operation)throw std::runtime_error("Timeline operation is null");frosty::TimelineCommand c;c.kind=frosty::CommandKind::TimelineEdit;c.sequenceId=activeSeqId(x->project);std::string op=operation;if(op=="ripple-delete")c.editKind=frosty::EditKind::RippleDelete;else if(op=="insert-gap")c.editKind=frosty::EditKind::InsertGap;else if(op=="overwrite")c.editKind=frosty::EditKind::Overwrite;else throw std::runtime_error("Unsupported range operation");c.start=start;c.end=end;if(!x->history.execute(x->project,c))throw std::runtime_error("Timeline range edit rejected");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown timeline range edit error");return 0;}
}
int frosty_project_set_clip_range(frosty_project_handle h,const char* clip_id,double in_time,double out_time,char* error,int cap){try{auto*x=get(h);if(!clip_id)throw std::runtime_error("Clip ID is required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::SetClipRange;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;c.start=in_time;c.end=out_time;if(!x->history.execute(x->project,c))throw std::runtime_error("Could not set clip range");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
int frosty_project_remove_clip(frosty_project_handle h,const char* clip_id,char* error,int cap){try{auto*x=get(h);if(!clip_id)throw std::runtime_error("Clip ID is required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::RemoveClip;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;if(!x->history.execute(x->project,c))throw std::runtime_error("Could not remove clip");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
int frosty_project_set_clip_volume(frosty_project_handle h,const char* clip_id,double volume,char* error,int cap){try{auto*x=get(h);if(!clip_id)throw std::runtime_error("Clip ID is required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::SetClipVolume;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;c.val=volume;if(!x->history.execute(x->project,c))throw std::runtime_error("Clip volume update rejected");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown volume error");return 0;}}
int frosty_project_set_clip_mask_json(frosty_project_handle h,const char* clip_id,const char* mask_json,char* error,int cap){try{auto*x=get(h);if(!clip_id||!mask_json)throw std::runtime_error("Clip ID and mask JSON are required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::SetClipMask;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;c.value=mask_json;if(!x->history.execute(x->project,c))throw std::runtime_error("Clip mask update rejected");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown clip mask error");return 0;}}
int frosty_project_set_clip_effect(frosty_project_handle h,const char* clip_id,const char* effect_type,const char* parameter_name,double value,int enabled,char* error,int cap){try{auto*x=get(h);if(!clip_id||!effect_type||!parameter_name)throw std::runtime_error("Clip, effect and parameter are required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::SetEffect;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;c.text=effect_type;c.propName=parameter_name;c.val=value;c.flag=enabled!=0;if(!x->history.execute(x->project,c))throw std::runtime_error("Effect update rejected");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown effect error");return 0;}}
int frosty_project_set_clip_keyframe(frosty_project_handle h,const char* clip_id,const char* property_name,double time,double value,const char* interpolation,char* error,int cap){try{auto*x=get(h);if(!clip_id||!property_name)throw std::runtime_error("Clip ID and property name are required");frosty::TimelineCommand c;c.kind=frosty::CommandKind::SetKeyframe;c.sequenceId=activeSeqId(x->project);c.entityId=clip_id;c.propName=property_name;c.time=time;c.val=value;c.interpolation=interpolation?interpolation:"linear";if(!x->history.execute(x->project,c))throw std::runtime_error("Could not set keyframe");return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
double frosty_project_evaluate_keyframe(frosty_project_handle h,const char* clip_id,const char* property_name,double time,double default_value){try{auto*x=get(h);if(!clip_id||!property_name)return default_value;for(const auto& seq:x->project.sequences)for(const auto& clip:seq.clips)if(clip.id==clip_id)return frosty::evaluateKeyframe(clip,property_name,time,default_value);return default_value;}catch(...){return default_value;}}
int frosty_project_undo(frosty_project_handle h){try{return get(h)->history.undo(get(h)->project)?1:0;}catch(...){return 0;}}
int frosty_project_redo(frosty_project_handle h){try{return get(h)->history.redo(get(h)->project)?1:0;}catch(...){return 0;}}
int frosty_project_recovery_snapshot(frosty_project_handle h,const char* dir,char* error,int cap){try{if(!dir)throw std::runtime_error("Recovery directory is null");frosty::saveRecoverySnapshot(get(h)->project,dir,10);return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
frosty_project_handle frosty_project_recover_latest(const char* dir,char* error,int cap){try{if(!dir)throw std::runtime_error("Recovery directory is null");return new Handle(frosty::recoverLatestSnapshot(dir));}catch(const std::exception&e){setError(error,cap,e.what());return nullptr;}catch(...){setError(error,cap,"Unknown native engine error");return nullptr;}}
#ifdef _WIN32
int frosty_project_recovery_snapshot_w(frosty_project_handle h,const wchar_t* dir,char* error,int cap){try{if(!dir)throw std::runtime_error("Recovery directory is null");frosty::saveRecoverySnapshot(get(h)->project,std::filesystem::path(dir),10);return 1;}catch(const std::exception&e){setError(error,cap,e.what());return 0;}catch(...){setError(error,cap,"Unknown native engine error");return 0;}}
frosty_project_handle frosty_project_recover_latest_w(const wchar_t* dir,char* error,int cap){try{if(!dir)throw std::runtime_error("Recovery directory is null");return new Handle(frosty::recoverLatestSnapshot(std::filesystem::path(dir)));}catch(const std::exception&e){setError(error,cap,e.what());return nullptr;}catch(...){setError(error,cap,"Unknown native engine error");return nullptr;}}
#endif
const char* frosty_project_validation(frosty_project_handle h){static thread_local std::string result;try{auto report=frosty::validateAndRepair(get(h)->project,false);std::ostringstream o;o<<"{\"valid\":"<<(report.hasErrors()?"false":"true")<<",\"issues\":[";for(std::size_t i=0;i<report.issues.size();++i){if(i)o<<',';auto&v=report.issues[i];o<<"{\"severity\":\""<<escapeJson(v.severity)<<"\",\"code\":\""<<escapeJson(v.code)<<"\",\"message\":\""<<escapeJson(v.message)<<"\",\"entityId\":\""<<escapeJson(v.entityId)<<"\"}";}o<<"]}";result=o.str();return result.c_str();}catch(...){return "{\"valid\":false,\"issues\":[]}";}}
void frosty_project_destroy(frosty_project_handle h){delete static_cast<Handle*>(h);}
}
