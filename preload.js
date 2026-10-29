const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const allowedEvents = new Set([
  'ai:status',
  'analysis:status',
  'preview:movie:progress',
  'export:progress',
  'export:encoder',
]);
const subscribe = (channel, callback) => {
  if (!allowedEvents.has(channel) || typeof callback !== 'function') {
    return () => {};
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('frosty', {
  getSettings: call('settings:get'), setSettings: call('settings:set'),
  importMedia: call('media:import'), pickMusic: call('media:music'), createProxy: call('media:proxy'), relinkProjectMedia: call('project:relink'), scanAndRelinkProjectMedia: call('project:relink:scan'), validateTimeline: call('project:validate'), repairTimeline: call('project:repair'), sequence: call('project:sequence'),
  silence: call('ai:silence'), transcribe: call('ai:transcribe'), plan: call('ai:plan'), brag: call('ai:brag'), bragRender: call('brag:render'), bragPickSoundtrack: call('brag:pick-soundtrack'), bragShareCopy: call('brag:share-copy'), bragSaveDraft: call('brag:save-draft'), bragOpenDraft: call('brag:open-draft'),
  assets: call('media:assets'), indexMedia: call('media:index'), searchScenes: call('media:search-scenes'), models: call('models:list'), download: call('reach:download'), inspectVideo: call('reach:inspect-video'), copyTemplate: call('reach:copy-template'), compareReference: call('reference:compare-render'), previewMotionGraphic: call('motion:preview'), createMotionGraphic: call('motion:create'), doctor: call('reach:doctor'), classifyUrl: call('reach:classify'), reachPlatforms: call('reach:platforms'), reachTranscript: call('reach:transcript'), reachDiagnostics: call('reach:diagnostics'), reachRead: call('reach:read'), reachSearch: call('reach:search'), reachOpenResult: call('reach:open-result'), keyInfo: call('key:info'), scenes: call('media:scenes'), genImage: call('ai:image'), agent: call('ai:agent'),
  analyzeTimeline: call('analysis:timeline'), analyzeMedia: call('analysis:media'), analyzeScopesAtFrame: call('analysis:scopes:frame'), measureTimelineMix: call('analysis:mixdown'), saveAnalysisReport: call('analysis:save-report'),
  previewFrame: call('preview:frame'), cancelPreview: () => ipcRenderer.send('preview:cancel'), previewMovie: call('preview:movie'), cancelPreviewMovie: () => ipcRenderer.send('preview:movie:cancel'), exportVideo: call('export:run'), saveProject: call('project:save'), openProject: call('project:open'),
  on: subscribe,
});
