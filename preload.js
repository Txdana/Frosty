const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('frosty', {
  getSettings: call('settings:get'), setSettings: call('settings:set'),
  importMedia: call('media:import'), pickMusic: call('media:music'),
  silence: call('ai:silence'), transcribe: call('ai:transcribe'), plan: call('ai:plan'), brag: call('ai:brag'),
  assets: call('media:assets'), indexMedia: call('media:index'), searchScenes: call('media:search-scenes'), models: call('models:list'), download: call('reach:download'), doctor: call('reach:doctor'), keyInfo: call('key:info'), scenes: call('media:scenes'), genImage: call('ai:image'), agent: call('ai:agent'),
  exportVideo: call('export:run'), saveProject: call('project:save'), openProject: call('project:open'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, p) => fn(p)),
});
