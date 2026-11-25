// Changes to the official Windows and macOS Grok Bot 1.2.3 app.asar, built into
// windows/patchers/desktop/recipes and mac/patchers/desktop/recipes by build.mjs.
// Each anchor must occur exactly once in its source; a different official build is
// refused instead of being half patched. Code that the recipes append lives in
// extensions/ (it is the source, not dead code).
//
// Edits: { prepend | append | replaceAll: text }, { insertBefore | insertAfter: anchor, text },
// { replace: anchor, text }, { cutFrom: anchor, text } (drops the rest of the file),
// { removeThrough: [startAnchor, endAnchor], text }.
import { readFileSync } from 'node:fs';

const extension = name => readFileSync(new URL(`./extensions/${name}`, import.meta.url), 'utf8');
// The admin page's count formatter and usage charts, shipped to the settings (Usage section).
const publicFile = name => readFileSync(new URL(`../../../host/server/public/${name}`, import.meta.url), 'utf8');
const usageFormat = () => publicFile('usage-format.js');
// rok-usage-charts.js: usage-charts.js importing the renderer's copy of the formatter, with
// usage-charts.css as a string (the admin page links it; the settings add it in a <style>).
export function usageCharts() {
  const source = publicFile('usage-charts.js'), from = "from './usage-format.js';";
  if (source.split(from).length !== 2) throw new Error('usage-charts.js must import usage-format.js once');
  return source.replace(from, "from './rok-usage-format.js';") + `\nexport const ROK_USAGE_CHART_CSS = ${JSON.stringify(publicFile('usage-charts.css'))};\n`;
}
const USAGE_FORMAT = "import { formatCount as rokFormatCount, formatExactCount as rokFormatExactCount, withRequestUnit as rokWithRequestUnit } from './rok-usage-format.js';\n"
  + "import { usageView as rokUsageView, attachUsageTooltip as rokAttachUsageTooltip, ROK_USAGE_CHART_CSS } from './rok-usage-charts.js';\n";
const asset = name => `dist/renderer/assets/${name}`;
const edit = (name, edits) => ({ path: asset(name), source: asset(name), edits });
const I18N = "import { grokText } from './grok-local-i18n.js';\n";

export const TARGETS = Object.freeze({
  windows: Object.freeze({
    target: 'windows',
    version: '1.2.3',
    architecture: 'x64',
    label: 'Windows x64',
    recipesRelativeDir: 'windows/patchers/desktop/recipes',
    cacheRelativeDir: 'windows/.cache',
    archive: Object.freeze({
      url: 'https://downloads.cursor.com/grokbot/stable/win32-x64/1.2.3/Grok_Bot_1.2.3_Setup.exe',
      bytes: 127618944,
      sha256: '85b9e8d10b9ede921b315bb5a1b52db7e0f3438d162aacedfc388c778217765b',
    }),
    payload: Object.freeze({
      name: 'app-64.7z',
      bytes: 126693944,
      sha256: '84d20f0f2b5a1eacc523015ed723f315c76395646d9d6c28295c8704b809c5df',
    }),
    asarSha256: 'b1354ec5ae877e94115a643edd4b2e7487929f0a1dfb398411ab314b488ee0d2',
    asarHeaderSha256: 'cfd92fb7d75ddc50c5214fcca3a561cd9b2d0a26dee763e5585182ee6ac63e80',
    chunks: Object.freeze({
      sentrySdk: 'chunk-sentry-sdk-3vEdLH0q.js',
      eagerCommon: 'index.eager-common-D2eZn7JB.js',
      connectedApps: 'chunk-view-CAIvK0CV.js',
      connectedAppsEmpty: 'chunk-view-CKkh6v_e.js',
      library: 'chunk-bot-store-files-library-BNT_Yru2.js',
      generalPane: 'chunk-general-pane-DQZ54SyA.js',
      computerView: 'chunk-view-B9ngRQ84.js',
      updateView: 'chunk-view-xV8CbwrQ.js',
      marketplaceModel: 'chunk-marketplace-browse-model-BlgGQ3lx.js',
      pluginDetail: 'chunk-plugin-detail-view-XqXPQSt0.js',
      eagerApp: 'index.eager-app-DodVIpEt.js',
    }),
  }),
  mac: Object.freeze({
    target: 'mac',
    version: '1.2.3',
    bundleId: 'com.anysphere.sand',
    architecture: 'arm64',
    label: 'macOS arm64',
    recipesRelativeDir: 'mac/patchers/desktop/recipes',
    cacheRelativeDir: 'mac/.cache',
    archive: Object.freeze({
      url: 'https://downloads.cursor.com/grokbot/stable/darwin-arm64/1.2.3/Grok_Bot_1.2.3.dmg',
      bytes: 159560653,
      sha256: 'b7c6268d40bf92b43b6f2eddd733e4d5b5d36e229d2201d06298a19b0e62da08',
    }),
    asarSha256: '84d8cddca0676154a8cae13ca1f4ce8cae1703fdfa1b7b0175c4395d95f702cf',
    asarHeaderSha256: '2d298ecea742eb986effb570427fe7197506a83bc0248aef9ac43baa764128a9',
    frameworkSha256: 'dd6f9a73c7d5aa0dba937e5b02fd70b19c8deb85ce28c3ac79a83ab24488dcf6',
    chunks: Object.freeze({
      sentrySdk: 'chunk-sentry-sdk-CcmPN8dv.js',
      eagerCommon: 'index.eager-common-D2eZn7JB.js',
      connectedApps: 'chunk-view-BG_fyL97.js',
      connectedAppsEmpty: 'chunk-view-t9SaSXkD.js',
      library: 'chunk-bot-store-files-library-cLISLDBk.js',
      generalPane: 'chunk-general-pane-GzzbbXEN.js',
      computerView: 'chunk-view-DBvIFHc9.js',
      updateView: 'chunk-view-BuQdbmNp.js',
      marketplaceModel: 'chunk-marketplace-browse-model-DkSCYsML.js',
      pluginDetail: 'chunk-plugin-detail-view-Jm29_C8X.js',
      eagerApp: 'index.eager-app-C3AkkLux.js',
    }),
  }),
});

export function targetMeta(target = 'windows') {
  const meta = TARGETS[target];
  if (!meta) throw new Error(`Unsupported recipe target: ${target}`);
  return meta;
}

export function specForTarget(target = 'windows') {
  const { chunks } = targetMeta(target);
  return [
    // The local client (mac/clients/desktop) reuses a few original main-process modules. Each
    // copy stops before the original entry point runs and exports what the client needs.
    {
      path: 'dist/electron-main/local-browser.cjs', source: 'dist/electron-main/main-app.cjs',
      edits: [
        { prepend: 'require("./local-shared.cjs");\n' },
        { cutFrom: 'var Wvt=S(vh()),qvt=S(fvt()),be=(0,Vvt.readMainCoreHandoff)();',
          text: '\nmodule.exports={requestPasskey:NVe,requestPin:DVe,updatePasskey:aXt,finishPasskey:s8};\n' },
      ],
    },
    {
      path: 'dist/electron-main/local-shared.cjs', source: 'dist/electron-main/main-core.cjs',
      edits: [
        { cutFrom: 'w9({killSwitch:process.env.CURSOR_DISABLE_HALF_OPEN_ASYNC_ITERATOR_FIX});var NJ=dNe(),OHe=U9({scope:"sand-desktop"});',
          text: '\nmodule.exports={activateLocale:Gp};\n' },
      ],
    },
    {
      path: 'dist/local-exec-daemon/main.cjs', source: 'dist/local-exec-daemon/main.cjs',
      edits: [
        { removeThrough: ['$Ht().catch(r=>{let e=r instanceof Error?r:new Error(String(r));process.stderr.write(`[sand-local-exec-daemon] fatal:',
          'finally(()=>process.exit(1))});'],
          text: 'module.exports={Provider:Xw,ComputerUse:Zw,findComputerHelper:tDe,decideLocalUse:jW,isLocalUseBlocked:p9e,retireApproval:d9e,parseApproval:Rct};' },
      ],
    },
    {
      path: 'dist/node-agent-coordinator/local-browser.cjs', source: 'dist/node-agent-coordinator/main.cjs',
      edits: [
        { cutFrom: 'oRe().catch(n=>{process.stderr.write(`node-agent-coordinator: composition failure:',
          text: '\nmodule.exports={passkeyProvider:WH,signer:e2,findSigner:QH,relyingParty:zH,interval:Is,reconnect:rRe,deadline:nt,watchdog:zr,delivery:Jt,expiry:Pi};\n' },
      ],
    },

    { path: asset('grok-local-i18n.js'), source: null, edits: [{ append: extension('grok-local-i18n.js') }] },
    { path: asset('rok-usage-format.js'), source: null, edits: [{ append: usageFormat() }] },
    { path: asset('rok-usage-charts.js'), source: null, edits: [{ append: usageCharts() }] },

    // No crash reports leave the local client.
    edit(chunks.sentrySdk, [
      { replaceAll: 'const noop=()=>{};export function initSandSentrySdk(){return{captureException:noop,captureMessage:noop,setTag:noop,withScope:noop}}' },
    ]),
    edit(chunks.eagerCommon, [
      { insertBefore: 'if(Yt(e[0])){if(Wt.size===0)qt({kind:`exception`,args:e})', text: 'return;' },
      { insertBefore: 'if(Wt.size===0)qt({kind:`message`,args:e})', text: 'return;' },
    ]),

    // Connected apps: only apps the Host can serve, a local empty state and the Host's share link.
    edit(chunks.connectedApps, [
      { replace: 'c=r?n.filter(il):n;', text: 'c=n.filter(il);' },
      { replace: 'onSelect:()=>y(hn(O)),children:F', text: 'onSelect:()=>y(n.shareUrl),children:F' },
    ]),
    edit(chunks.connectedAppsEmpty, [
      { prepend: I18N },
      { replace: 'i=r({id:`kxskKD`})', text: 'i=grokText(`暂无连接应用`,`No connected apps`)' },
    ]),

    // Bot library: the Host accepts 20 MiB per file, 100 files and 100 MiB per Bot. Host Bots
    // keep one shared library and no per-user store; files can be picked as well as dropped.
    edit(chunks.library, [
      { prepend: `${I18N}import { yT as GrokButton } from './${chunks.eagerApp}';\n` },
      { replace: 'ie=26214400,j=1073741824', text: 'ie=20971520,j=104857600' },
      { replace: 'e.sizeBytes>26214400?{kind:`too-large`}:t.fileCount>=200?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>1073741824?',
        text: 'e.sizeBytes>20971520?{kind:`too-large`}:t.fileCount>=100?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>104857600?' },
      { replace: 'values:{limit:200,names:t}', text: 'values:{limit:100,names:t}' },
      { replace: 'let he;return t[57]!==J||t[58]!==$?(he=(0,V.jsxs)(V.Fragment,{children:[J,$]}),t[57]=J,t[58]=$,t[59]=he):he=t[59],he}',
        text: 'return(0,V.jsxs)(V.Fragment,{children:[j?(0,V.jsx)(GrokLibraryUpload,{upload:N,disabled:P}):null,$]})}' },
      { append: extension('library.js') },
    ]),

    // Settings > General: the account card shows this Host and opens the connection dialog;
    // model configuration & realtime voice are local settings; the Host's token usage per model;
    // no security key proxy (drop C=va, keep S=Xi).
    edit(chunks.generalPane, [
      { prepend: I18N },
      { prepend: USAGE_FORMAT },
      { replace: '(W=(0,$.jsx)(`span`,{className:U,children:F}),',
        text: '(W=typeof F==`string`?(0,$.jsx)(GrokAccountName,{className:U,name:F,onCommit:name=>n.updateName(name)}):(0,$.jsx)(`span`,{className:U,children:F}),' },
      { replace: '(ie=(0,$.jsx)(`span`,{className:re,children:j}),', text: '(ie=(0,$.jsx)(`span`,{className:re,children:(0,$.jsx)(GrokAccountHost,{})}),' },
      { replace: '(se=k?(0,$.jsx)(q,{disabled:I,onClick:i?()=>void n.cancelLoginFlight():()=>void c(),size:`md`,style:gr.actionWeakBorder,variant:`secondary`,children:i?(0,$.jsx)(Y,{id:`dEgA5A`}):(0,$.jsx)(Y,{id:`MPPZ54`})}):null,',
        text: '(se=(0,$.jsx)(GrokHostConnection,{}),' },
      // Notification sounds are a development-only section upstream; show it without DEV markers.
      { replace: ':(n=t?(0,$.jsx)(Zi,{}):null,', text: ':(n=(0,$.jsx)(Zi,{}),' },
      { replace: '(f=(0,$.jsx)(rt,{children:d}),', text: '(f=d,' },
      { replace: 'label:ke(n({id:`6EhUT7`}))', text: 'label:n({id:`6EhUT7`})' },
      { replace: '"aria-label":ke(n({id:`wm7RV4`}))', text: '"aria-label":n({id:`wm7RV4`})' },
      // Auto-review: a short description, and no team-rule hints.
      { replace: '(g=a(l==null?{id:`De8ppO`}:{id:`QqKsGg`}),', text: '(g=l==null?grokText(`运行操作前检查，需要时询问。`,`Review actions and ask when needed.`):a({id:`QqKsGg`}),' },
      { replace: '(0,$.jsx)(Un,{children:(0,$.jsx)(Y,{id:`NFRGrQ`})})', text: 'null' },
      { replace: '(0,$.jsx)(it,{as:`span`,color:`tertiary`,level:`body2`,children:h})]}):null', text: 'null]}):null' },
      { replace: 'children:[l,f,p,m,b,x,h,g,_,v,y,S,C,w,T,E]',
        text: 'children:[l,f,(0,$.jsx)(RokListArrangementSettings,{}),(0,$.jsx)(RokModelSettings,{}),(0,$.jsx)(RokUsageSettings,{}),(0,$.jsx)(GrokRealtimeVoiceSettings,{}),p,m,b,x,h,g,_,v,y,S,w,T,E]' },
      { append: extension('general-pane.js') },
    ]),

    // Settings > Computer: the Host manages the Bot's computer; this computer's access stays.
    edit(chunks.computerView, [
      { prepend: I18N },
      { replace: '(0,Q.jsxs)(`div`,{...n,children:[i,a,o,s]})', text: '(0,Q.jsxs)(`div`,{...n,children:[(0,Q.jsx)(GrokRemoteDesktop,{}),i,a,o]})' },
      { append: extension('computer-view.js') },
    ]),

    // Settings > Updates: RokBot 1.2.3 local version card (hooked by update-config.mjs & renderer-patches.mjs).
    edit(chunks.updateView, [
      { prepend: I18N },
      { replace: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(T,{})}),', text: '(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),' },
      { append: extension('update-view.js') },
    ]),

    // Marketplace: apps the Host provides form their own category without public links.
    edit(chunks.marketplaceModel, [
      { replace: 'var u=[`credentials`,', text: 'var u=[`host`,`credentials`,' },
      { replace: 'd={LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,', text: 'd={HOST:`host`,LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,' },
      { replace: 'var T={credentials:{id:`P+nzjE`},', text: 'var T={host:{id:`Host`,message:`Host`},credentials:{id:`P+nzjE`},' },
    ]),
    edit(chunks.pluginDetail, [
      { replace: 'function kt(e,t){if(e.marketplace?.ownership===`user`)return null;',
        text: 'function kt(e,t){if(e.category===`Host`)return null;if(e.marketplace?.ownership===`user`)return null;' },
    ]),

    edit(chunks.eagerApp, [
      { prepend: I18N },
      { replace: 'let d;e[5]===Symbol.for(`react.memo_cache_sentinel`)?(d=(0,Z.jsx)(dDr,{}),e[5]=d):d=e[5];',
        text: 'let d=(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsx)(dDr,{}),(0,Z.jsx)(RokNeedsModelBanner,{}),(0,Z.jsx)(RokModelConfigHost,{})]});' },
      { replace: 'vV={FEATURED:{id:`FkMol5`},', text: 'vV={HOST:{id:`Host`,message:`Host`},FEATURED:{id:`FkMol5`},' },
      // Account menu: connection settings instead of adding a cloud account; no mobile app offer.
      { replace: '(ht=(0,Z.jsxs)(zw.Section,{children:[ut,dt,mt]}),', text: '(ht=(0,Z.jsxs)(zw.Section,{children:[dt,mt]}),' },
      { replace: 'onSelect:et,children:(0,Z.jsx)(qo,{id:`MPPZ54`})}):null,',
        text: 'onSelect:()=>{window.__grokLocalConnectionRequested=true;c(`general`);window.dispatchEvent(new Event(`grokbot-local:connect-request`))},children:grokText(`连接设置`,`Connection settings`)}):null,' },
      // Signing out disconnects from the Host; nothing stays on a cloud computer.
      { replace: 'description:_ae(e)===null?na._({id:`5qRD8O`}):na._({id:`W51kAS`})', text: 'description:``' },
      // Bot settings: title, instructions and library files are kept on the Host; the Host
      // chooses the voice, so neither the Bot nor a call offers voice settings.
      { replace: 'return t[26]!==v||t[27]!==y?(b=(0,Z.jsxs)(`div`,{className:c,children:[v,y]}),t[26]=v,t[27]=y,t[28]=b):b=t[28],b',
        text: 'return t[26]!==v||t[27]!==y?(b=(0,Z.jsxs)(`div`,{className:c,children:[v,y,(0,Z.jsx)(GrokLocalSettings,{agent:n})]}),t[26]=v,t[27]=y,t[28]=b):b=t[28],b' },
      { insertAfter: 'function _N(e){', text: 'return null;' },
      // Connected apps: no link to the cloud Bot templates.
      { insertAfter: 'function k1t(){k1t.d=2596;', text: 'return null;' },
      // No crash reporter, heap samples or idle sampling.
      { insertAfter: 'function f6e(e,t,n=d6e){', text: 'return{load:async()=>{},setTag:()=>{}};' },
      { insertAfter: 'function AZr(e,t,n={}){', text: 'return()=>{};' },
      { insertAfter: 'function LZr(e,t=document){', text: 'return{sampleIdleMinutes:()=>void 0,stop:()=>{}};' },
      // Realtime calls go to the Host relay (host/server/voice-session.mjs).
      { replace: 'ue=(t,n)=>e.source.setVoiceCallPresence({id:t.agentId,callId:t.callId,isOnTheLine:n,acceptsOverheard:t.acceptsOverheard})',
        text: 'ue=(t,n)=>Promise.resolve()' },
      { insertAfter: 'De=async(t,n,r,i)=>{if(!hK.canHangUp(t.phase))return;', text: 'n===`hung-up`&&t.session?.localVoiceEndCall?.();' },
      { replace: 'I=e=>e.didConnect?(e.journalLine??=', text: 'I=e=>!1?(e.journalLine??=' },
      { insertBefore: 'let n=j();if(n===null||n.phase===`ending`||n.agentId!==t.agentId||n.callId!==t.callId', text: 'return;' },
      { insertBefore: 'let i=j();if(i===null||!hK.isCallerOnTheLine(i.phase)||i.agentId!==t||n!==i.thread.sessionId)return;Ae(i,r);', text: 'return;' },
      // Turning realtime voice off in Settings ends the current call.
      { insertAfter: 'Ne=e.transcript.observeEntriesFeed({onAppended:je,onBaseline:Me,onFetched:({agentId:e,sessionId:t,read:n})=>Me({agentId:e,sessionId:t,entries:n})})',
        text: ',grokVoicePreferenceRelease=window.localBot.onVoicePreferenceChanged(enabled=>{enabled||void re()})' },
      { replace: 'dispose(){Ne();', text: 'dispose(){grokVoicePreferenceRelease(),Ne();' },
      // The local client mints a short-lived ticket for this Host; only that address is dialable.
      { replace: 'let r=await e.desktop.mintVoiceCallCredential();',
        text: 'let r=await window.localBot.mintVoiceCredential(this.dial.agentId);grokVoiceEndpoint=r.ok?r.credential.websocketUrl:null;' },
      { replace: 'function _Xr(e){return gXr(e.desktop,hXr(e))}',
        text: 'function _Xr(e){return{session:async()=>({instructions:``,tools:[],hasOverheard:!1,greeting:{direction:``,withLandedWork:``}}),callTool:async()=>{throw Error(`Voice tools are managed by the Host`)}}}' },
      { replace: 'var r1r=class e{static DIALABLE_ORIGIN=`wss://api.x.ai/`;static isDialableURL(t){return t.startsWith(e.DIALABLE_ORIGIN)}',
        text: 'let grokVoiceEndpoint=null;var r1r=class e{static isDialableURL(t){return typeof t==`string`&&t===grokVoiceEndpoint}' },
      // Speech plays through a media element, and the Host hears playback.done & session.close.
      { replace: 'let s=r.createMediaStreamDestination(),c=new e(r,a,o,s,t);return c.hold(n,i),c}',
        text: 'let s=r.createMediaStreamDestination(),speaker=new Audio;speaker.autoplay=!0,speaker.srcObject=s.stream,await speaker.play();let c=new e(r,a,o,s,t);return c.localOutput=speaker,c.hold(n,i),c}' },
      { replace: 'n.connect(this.context.destination),n.connect(this.speakerTap);', text: 'n.connect(this.speakerTap);' },
      { replace: 'teardown(){this.dropScheduledSpeech(),', text: 'teardown(){this.localOutput?.pause(),this.localOutput&&(this.localOutput.srcObject=null),this.dropScheduledSpeech(),' },
      { replace: 'responseHeard=[];socket;router;responses;', text: 'responseHeard=[];localVoiceHeard=new Set;localVoiceGeneration=0;socket;router;responses;' },
      { replace: 'onCallerInterrupted:()=>{this.cancelUserFirstOpen(),', text: 'onCallerInterrupted:()=>{this.localVoiceGeneration++,this.localVoiceHeard.clear(),this.cancelUserFirstOpen(),' },
      { replace: 'onAssistantResponseEnded:e=>{this.sendTruncations(', text: 'onAssistantResponseEnded:e=>{e||void this.localVoicePlaybackDone(),this.sendTruncations(' },
      { replace: 't.speak(e,this.responses.speaksForNudgeId),this.args.handlers.onAudioReceived?.()',
        text: 't.speak(e,this.responses.speaksForNudgeId),e.itemId!==null&&this.localVoiceHeard.add(e.itemId),this.args.handlers.onAudioReceived?.()' },
      { insertAfter: 'thisResponseHasBeenHeard(){for(let e of this.responseHeard.splice(0))e()}',
        text: 'async localVoicePlaybackDone(){let items=[...this.localVoiceHeard],generation=this.localVoiceGeneration,audio=this.audio;if(audio===null||items.length===0)return;try{await audio.whenScheduledSpeechEnds()}catch{return}if(this.phase.kind!==`live`||generation!==this.localVoiceGeneration||this.router.callerIsSpeaking||this.socketSilentlyDiscardsFrames())return;for(let item_id of items)this.socket.send(JSON.stringify({type:`response.playback.done`,item_id}));this.localVoiceHeard.clear()}localVoiceEndCall(){this.socketSilentlyDiscardsFrames()||this.socket.send(JSON.stringify({type:`session.close`}))}' },
      { replace: 't.kind===`event`&&this.router.route(t.event)',
        text: 't.kind===`event`&&((t.event.type===`response.created`||t.event.type===`response.cancelled`)&&(this.localVoiceGeneration++,this.localVoiceHeard.clear()),this.router.route(t.event))' },
      { replace: 'openAfterUserFirstGrace(){let e=this.pendingConnectGreeting;e!==null&&(this.pendingConnectGreeting=null,this.responses.greet(e))}',
        text: 'openAfterUserFirstGrace(){this.cancelUserFirstOpen()}' },
      { replace: 'resumption:{enabled:!0}', text: 'resumption:{enabled:!1}' },
      { append: `\nconst ROK_LIBRARY_CHUNK = './${chunks.library}';\nconst ROK_GENERAL_PANE_CHUNK = './${chunks.generalPane}';\n` },
      // Session list arrangement: "activity" ranks Bots on their last message in the groups
      // waiting on you / unread / read (extensions/list-arrangement.js). The generated groups
      // are sections the user cannot rename or delete, and open cards also mark a row.
      { replace: 'let{visibleAgents:ie,hiddenAgents:ae}=re,oe;',
        text: 'let{visibleAgents:ie,hiddenAgents:ae}=re,oe;({visibleAgents:ie,sidebarSections:A,setSectionCollapsed:P,editSections:j}=RokUseArrangedSidebar({visibleAgents:ie,sidebarSections:A,setSectionCollapsed:P,editSections:j}));' },
      { replace: 'isSynthetic:e.id===ile,', text: 'isSynthetic:e.id===ile||rokListIsGroupId(e.id),' },
      { replace: 'function V_t(e,t){let n=null;return e.awaitingUserResponse==null?',
        text: 'function V_t(e,t){let n=null;return e.awaitingUserResponse==null&&e.pendingAction==null?' },
      // The wind chime toggle sits left of Search in the list header (Web phones: left of the
      // Search field, web/client/android.css).
      { replace: ':null,p,f==null?(0,Z.jsx)(He,{content:g({id:`2hjDEV`})',
        text: ':null,(0,Z.jsx)(RokListModeButton,{}),p,f==null?(0,Z.jsx)(He,{content:g({id:`2hjDEV`})' },
      // A generated group has no section menu: it cannot be renamed, moved or deleted.
      { replace: 'Oe=(0,Z.jsxs)(Bw,{children:[ue,De]})', text: 'Oe=(0,Z.jsxs)(Bw,{children:[ue,rokListIsGroupId(n.id)?null:De]})' },
      // It is neither dragged (only the drag listeners are left off, so the header stays an
      // enabled fold button) nor a drop target for Bots: the order comes from the messages.
      { replace: 'let le=o?void 0:j,ue;', text: 'let le=o||rokListIsGroupId(n.id)?void 0:j,ue;' },
      { replace: 'P={id:D.dndId,data:D.payload}', text: 'P={id:D.dndId,data:D.payload,disabled:rokListIsGroupId(n.id)}' },
      { append: extension('eager-app.js') },
      { append: extension('list-arrangement.js') },
    ]),

    // The render-trace hook installs a React DevTools stub for the vendor's render sampling.
    { path: 'dist/renderer/index.html', source: 'dist/renderer/index.html', edits: [
      { replace: '    <script src="./assets/dune-render-trace-hook-265eb7be.js"></script>\n', text: '' },
    ] },
  ];
}

export const SPEC = specForTarget('windows');
