#ifdef _WIN32
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>
#include "frosty/c_api.h"
using Microsoft::WRL::ComPtr;
namespace {
struct Vertex { float x,y,u,v; };
struct Renderer {
 HWND hwnd{}; UINT width{1280},height{720};
 ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context; ComPtr<IDXGISwapChain> swap;
 ComPtr<ID3D11RenderTargetView> target; ComPtr<ID3D11VertexShader> vs; ComPtr<ID3D11PixelShader> ps;
 ComPtr<ID3D11InputLayout> layout; ComPtr<ID3D11Buffer> vertices; ComPtr<ID3D11SamplerState> sampler; ComPtr<ID3D11BlendState> blend;
 std::string adapter{"Direct3D 11"};
 struct Layer { ComPtr<ID3D11Texture2D> texture; ComPtr<ID3D11ShaderResourceView> srv; ComPtr<ID3D11Buffer> constants; UINT w{},h{}; }; std::vector<Layer> layers;
};
const char* shader=R"(
struct V { float2 p:POSITION; float2 uv:TEXCOORD0; }; struct O { float4 p:SV_POSITION; float2 uv:TEXCOORD0; };
O VSMain(V i){ O o; o.p=float4(i.p,0,1); o.uv=i.uv; return o; }
Texture2D tex0:register(t0); SamplerState samp:register(s0); cbuffer C:register(b0){float opacity; float3 pad;}
float4 PSMain(O i):SV_TARGET { float4 c=tex0.Sample(samp,i.uv); c.a*=opacity; return c; }
)";
void seterr(char* e,int cap,const char* m){if(e&&cap>0){strncpy_s(e,(size_t)cap,m,_TRUNCATE);}}
void target(Renderer* r){r->target.Reset();ComPtr<ID3D11Texture2D> back;if(SUCCEEDED(r->swap->GetBuffer(0,IID_PPV_ARGS(&back))))r->device->CreateRenderTargetView(back.Get(),nullptr,&r->target);}
HRESULT init(Renderer* r){
 DXGI_SWAP_CHAIN_DESC sd{};sd.BufferCount=2;sd.BufferDesc.Width=r->width;sd.BufferDesc.Height=r->height;sd.BufferDesc.Format=DXGI_FORMAT_B8G8R8A8_UNORM;sd.BufferUsage=DXGI_USAGE_RENDER_TARGET_OUTPUT;sd.OutputWindow=r->hwnd;sd.SampleDesc.Count=1;sd.Windowed=TRUE;sd.SwapEffect=DXGI_SWAP_EFFECT_DISCARD;
 D3D_FEATURE_LEVEL level{};HRESULT hr=D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_HARDWARE,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&sd,&r->swap,&r->device,&level,&r->context);
 if(FAILED(hr)) hr=D3D11CreateDeviceAndSwapChain(nullptr,D3D_DRIVER_TYPE_WARP,nullptr,D3D11_CREATE_DEVICE_BGRA_SUPPORT,nullptr,0,D3D11_SDK_VERSION,&sd,&r->swap,&r->device,&level,&r->context); if(FAILED(hr))return hr;
 ComPtr<ID3DBlob> vb,pb,errors;hr=D3DCompile(shader,strlen(shader),nullptr,nullptr,nullptr,"VSMain","vs_4_0",D3DCOMPILE_ENABLE_STRICTNESS,0,&vb,&errors);if(FAILED(hr))return hr;
 hr=D3DCompile(shader,strlen(shader),nullptr,nullptr,nullptr,"PSMain","ps_4_0",D3DCOMPILE_ENABLE_STRICTNESS,0,&pb,&errors);if(FAILED(hr))return hr;
 if(FAILED(r->device->CreateVertexShader(vb->GetBufferPointer(),vb->GetBufferSize(),nullptr,&r->vs)))return E_FAIL;
 if(FAILED(r->device->CreatePixelShader(pb->GetBufferPointer(),pb->GetBufferSize(),nullptr,&r->ps)))return E_FAIL;
 D3D11_INPUT_ELEMENT_DESC elements[]={{"POSITION",0,DXGI_FORMAT_R32G32_FLOAT,0,0,D3D11_INPUT_PER_VERTEX_DATA,0},{"TEXCOORD",0,DXGI_FORMAT_R32G32_FLOAT,0,8,D3D11_INPUT_PER_VERTEX_DATA,0}};
 if(FAILED(r->device->CreateInputLayout(elements,2,vb->GetBufferPointer(),vb->GetBufferSize(),&r->layout)))return E_FAIL;
 Vertex v[]={{-1,-1,0,1},{-1,1,0,0},{1,-1,1,1},{1,1,1,0}};D3D11_BUFFER_DESC bd{};bd.ByteWidth=sizeof(v);bd.Usage=D3D11_USAGE_IMMUTABLE;bd.BindFlags=D3D11_BIND_VERTEX_BUFFER;D3D11_SUBRESOURCE_DATA initData{v};if(FAILED(r->device->CreateBuffer(&bd,&initData,&r->vertices)))return E_FAIL;
 D3D11_SAMPLER_DESC ss{};ss.Filter=D3D11_FILTER_MIN_MAG_MIP_LINEAR;ss.AddressU=ss.AddressV=ss.AddressW=D3D11_TEXTURE_ADDRESS_CLAMP;ss.MaxLOD=D3D11_FLOAT32_MAX;if(FAILED(r->device->CreateSamplerState(&ss,&r->sampler)))return E_FAIL;
 D3D11_BLEND_DESC bs{};bs.RenderTarget[0].BlendEnable=TRUE;bs.RenderTarget[0].SrcBlend=D3D11_BLEND_SRC_ALPHA;bs.RenderTarget[0].DestBlend=D3D11_BLEND_INV_SRC_ALPHA;bs.RenderTarget[0].BlendOp=D3D11_BLEND_OP_ADD;bs.RenderTarget[0].SrcBlendAlpha=D3D11_BLEND_ONE;bs.RenderTarget[0].DestBlendAlpha=D3D11_BLEND_INV_SRC_ALPHA;bs.RenderTarget[0].BlendOpAlpha=D3D11_BLEND_OP_ADD;bs.RenderTarget[0].RenderTargetWriteMask=D3D11_COLOR_WRITE_ENABLE_ALL;if(FAILED(r->device->CreateBlendState(&bs,&r->blend)))return E_FAIL;
 ComPtr<IDXGIDevice> dxgi;if(SUCCEEDED(r->device.As(&dxgi))){ComPtr<IDXGIAdapter> ad;if(SUCCEEDED(dxgi->GetAdapter(&ad))){DXGI_ADAPTER_DESC desc{};if(SUCCEEDED(ad->GetDesc(&desc))){char name[256]{};WideCharToMultiByte(CP_UTF8,0,desc.Description,-1,name,sizeof(name),nullptr,nullptr);r->adapter=name;}}}
 target(r);return r->target.Get()!=nullptr?S_OK:E_FAIL;
}
}
extern "C" {
FROSTY_API void* frosty_gpu_preview_create(void* hwnd,int width,int height,char* error,int cap){try{auto r=new Renderer();r->hwnd=(HWND)hwnd;r->width=(UINT)std::max(16,width);r->height=(UINT)std::max(16,height);HRESULT hr=init(r);if(FAILED(hr)){seterr(error,cap,"Direct3D 11 renderer initialization failed (hardware and WARP paths). ");delete r;return nullptr;}return r;}catch(...){seterr(error,cap,"GPU preview initialization threw an exception.");return nullptr;}}
FROSTY_API int frosty_gpu_preview_resize(void* handle,int width,int height){auto r=(Renderer*)handle;if(!r)return 0;r->width=(UINT)std::max(16,width);r->height=(UINT)std::max(16,height);r->context->OMSetRenderTargets(0,nullptr,nullptr);r->target.Reset();if(FAILED(r->swap->ResizeBuffers(0,r->width,r->height,DXGI_FORMAT_UNKNOWN,0)))return 0;target(r);return r->target.Get()!=nullptr?1:0;}
FROSTY_API int frosty_gpu_preview_begin(void* handle){auto r=(Renderer*)handle;if(!r||r->target.Get()==nullptr)return 0;float clear[4]={0.015f,0.02f,0.035f,1};r->context->OMSetRenderTargets(1,r->target.GetAddressOf(),nullptr);r->context->ClearRenderTargetView(r->target.Get(),clear);D3D11_VIEWPORT vp{0,0,(float)r->width,(float)r->height,0,1};r->context->RSSetViewports(1,&vp);UINT stride=sizeof(Vertex),offset=0;auto vb=r->vertices.Get();r->context->IASetInputLayout(r->layout.Get());r->context->IASetVertexBuffers(0,1,&vb,&stride,&offset);r->context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);r->context->VSSetShader(r->vs.Get(),nullptr,0);r->context->PSSetShader(r->ps.Get(),nullptr,0);r->context->PSSetSamplers(0,1,r->sampler.GetAddressOf());float factors[4]={0,0,0,0};r->context->OMSetBlendState(r->blend.Get(),factors,0xffffffff);return 1;}
FROSTY_API int frosty_gpu_preview_submit_bgra(void* handle,int layerIndex,const unsigned char* pixels,int width,int height,int stride,float opacity){auto r=(Renderer*)handle;if(!r||!pixels||width<=0||height<=0||stride<width*4||layerIndex<0||layerIndex>63)return 0;if((size_t)layerIndex>=r->layers.size())r->layers.resize((size_t)layerIndex+1);auto& l=r->layers[(size_t)layerIndex];if(l.texture.Get()==nullptr||l.w!=(UINT)width||l.h!=(UINT)height){l={};D3D11_TEXTURE2D_DESC td{};td.Width=(UINT)width;td.Height=(UINT)height;td.MipLevels=td.ArraySize=1;td.Format=DXGI_FORMAT_B8G8R8A8_UNORM;td.SampleDesc.Count=1;td.Usage=D3D11_USAGE_DEFAULT;td.BindFlags=D3D11_BIND_SHADER_RESOURCE;if(FAILED(r->device->CreateTexture2D(&td,nullptr,&l.texture)))return 0;if(FAILED(r->device->CreateShaderResourceView(l.texture.Get(),nullptr,&l.srv)))return 0;struct Constants{float opacity,pad[3];} c{1,{0,0,0}};D3D11_BUFFER_DESC bd{};bd.ByteWidth=16;bd.Usage=D3D11_USAGE_DEFAULT;bd.BindFlags=D3D11_BIND_CONSTANT_BUFFER;D3D11_SUBRESOURCE_DATA cd{&c};if(FAILED(r->device->CreateBuffer(&bd,&cd,&l.constants)))return 0;l.w=(UINT)width;l.h=(UINT)height;}D3D11_BOX box{0,0,0,(UINT)width,(UINT)height,1};r->context->UpdateSubresource(l.texture.Get(),0,&box,pixels,(UINT)stride,0);struct Constants{float opacity,pad[3];} c{std::clamp(opacity,0.0f,1.0f),{0,0,0}};r->context->UpdateSubresource(l.constants.Get(),0,nullptr,&c,0,0);r->context->PSSetConstantBuffers(0,1,l.constants.GetAddressOf());r->context->PSSetShaderResources(0,1,l.srv.GetAddressOf());r->context->Draw(4,0);ID3D11ShaderResourceView* nullSrv=nullptr;r->context->PSSetShaderResources(0,1,&nullSrv);return 1;}
FROSTY_API int frosty_gpu_preview_present(void* handle){auto r=(Renderer*)handle;if(!r)return 0;return SUCCEEDED(r->swap->Present(1,0))?1:0;}
FROSTY_API const char* frosty_gpu_preview_adapter(void* handle){static thread_local std::string result;auto r=(Renderer*)handle;result=r?r->adapter:"unavailable";return result.c_str();}
FROSTY_API void frosty_gpu_preview_destroy(void* handle){delete (Renderer*)handle;}
}
#endif
