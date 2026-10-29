from pathlib import Path
root=Path(__file__).resolve().parents[1]
cpp=(root/'native/src/gpu_preview.cpp').read_text()
api=(root/'native/include/frosty/c_api.h').read_text()
cmake=(root/'native/CMakeLists.txt').read_text()
host=(root/'windows/Frosty.Desktop/GpuPreviewHost.cs').read_text()
xaml=(root/'windows/Frosty.Desktop/MainWindow.xaml').read_text()
cs=(root/'windows/Frosty.Desktop/MainWindow.xaml.cs').read_text()
checks={
 'Windows min/max macros disabled before windows.h':'#define NOMINMAX' in cpp and cpp.index('#define NOMINMAX') < cpp.index('#include <windows.h>'),
 'D3D11 hardware device and WARP fallback':'D3D_DRIVER_TYPE_HARDWARE' in cpp and 'D3D_DRIVER_TYPE_WARP' in cpp,
 'DXGI swap chain present':'IDXGISwapChain' in cpp and '->Present(1,0)' in cpp,
 'GPU shader and alpha blending':'D3DCompile' in cpp and 'D3D11_BLEND_SRC_ALPHA' in cpp,
 'Reusable D3D texture uploads':'UpdateSubresource' in cpp and 'std::vector<Layer>' in cpp,
 'Native preview API exported':'frosty_gpu_preview_submit_bgra' in api and 'frosty_gpu_preview_present' in api,
 'Windows Direct3D libraries linked':'d3d11 dxgi d3dcompiler' in cmake,
 'Continuous decode pipe, not per-tick seek':'StandardOutput.BaseStream.ReadAsync' in host and 'Start(VideoClip clip,double sourceOffset)' in host,
 'Multiple active layers composited in track order':'OrderBy(c=>c.TrackOrder)' in host and 'foreach(var clip in active)' in host,
 'WPF GPU timeline preview control and actions':'GpuPreviewHost x:Name="GpuPreviewSurface"' in xaml and 'GpuTimelinePlay_Click' in xaml,
 'Preview pause and stop integration':'GpuPreviewSurface.TogglePause()' in cs and 'GpuPreviewSurface.StopTimeline()' in cs,
}
for label,ok in checks.items(): print(('PASS' if ok else 'FAIL')+' '+label)
if not all(checks.values()): raise SystemExit(1)
