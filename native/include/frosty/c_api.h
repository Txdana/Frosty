#pragma once
#ifdef _WIN32
 #ifdef FROSTY_CORE_EXPORTS
  #define FROSTY_API __declspec(dllexport)
 #else
  #define FROSTY_API __declspec(dllimport)
 #endif
#else
 #define FROSTY_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
typedef void* frosty_project_handle;
FROSTY_API const char* frosty_core_version(void);
FROSTY_API frosty_project_handle frosty_project_create(void);
FROSTY_API frosty_project_handle frosty_project_load(const char* path, char* error, int error_capacity);
#ifdef _WIN32
FROSTY_API frosty_project_handle frosty_project_load_w(const wchar_t* path, char* error, int error_capacity);
#endif
FROSTY_API int frosty_project_save(frosty_project_handle project, const char* path, char* error, int error_capacity);
#ifdef _WIN32
FROSTY_API int frosty_project_save_w(frosty_project_handle project, const wchar_t* path, char* error, int error_capacity);
#endif
FROSTY_API const char* frosty_project_summary(frosty_project_handle project);
FROSTY_API const char* frosty_project_json(frosty_project_handle project);
FROSTY_API int frosty_project_add_track(frosty_project_handle project, const char* name, const char* type, char* error, int error_capacity);
FROSTY_API int frosty_project_set_track_state(frosty_project_handle project, const char* track_id, const char* property, int value, char* error, int error_capacity);
FROSTY_API int frosty_project_add_clip(frosty_project_handle project, const char* track_id, const char* asset_id, const char* name, double start, double in_time, double out_time, char* error, int error_capacity);
FROSTY_API int frosty_project_move_clip(frosty_project_handle project, const char* clip_id, double start, char* error, int error_capacity);
FROSTY_API int frosty_project_set_clip_range(frosty_project_handle project, const char* clip_id, double in_time, double out_time, char* error, int error_capacity);
FROSTY_API int frosty_project_remove_clip(frosty_project_handle project, const char* clip_id, char* error, int error_capacity);
FROSTY_API int frosty_project_set_clip_keyframe(frosty_project_handle project, const char* clip_id, const char* property_name, double time, double value, const char* interpolation, char* error, int error_capacity);
FROSTY_API double frosty_project_evaluate_keyframe(frosty_project_handle project, const char* clip_id, const char* property_name, double time, double default_value);
FROSTY_API int frosty_project_undo(frosty_project_handle project);
FROSTY_API int frosty_project_redo(frosty_project_handle project);
FROSTY_API int frosty_project_recovery_snapshot(frosty_project_handle project, const char* directory, char* error, int error_capacity);
FROSTY_API frosty_project_handle frosty_project_recover_latest(const char* directory, char* error, int error_capacity);
#ifdef _WIN32
FROSTY_API int frosty_project_recovery_snapshot_w(frosty_project_handle project, const wchar_t* directory, char* error, int error_capacity);
FROSTY_API frosty_project_handle frosty_project_recover_latest_w(const wchar_t* directory, char* error, int error_capacity);
#endif
FROSTY_API const char* frosty_project_validation(frosty_project_handle project);
FROSTY_API void frosty_project_destroy(frosty_project_handle project);
#ifdef __cplusplus
}
#endif
