import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer. All core logic (OpenRouter calls, skills, tools, key storage)
// runs in the main process; the UI only talks to it through these calls.
type ChatMode = { kind: 'free' } | { kind: 'auto' } | { kind: 'council'; author?: string; critic?: string } | { kind: 'model'; id: string }
type ChatOpts = { tabId: string; projectId: string | null; mode: ChatMode; allowWeaker?: boolean }
type SpeechPartResult = { ok: boolean; id?: string; url?: string; done?: boolean; error?: string }
type ChatResult = { content: string; meta?: string; cancelled?: boolean; failed?: boolean; needsChoice?: boolean; policyRefused?: boolean }
type SideStateInfo = { open: boolean; url: string | null; width: number; canGoBack: boolean }
type SideViewInfo = { open: boolean; host: string; zoom: number; font: string; reader: boolean; bookmarked: boolean; local: boolean }
type SideImportSource = { id: string; browser: string; label: string; profile: string; name: string; hasHistory: boolean; hasBookmarks: boolean }

const api = {
  chat: (userInput: string, history: { role: 'user' | 'assistant'; content: string }[] | undefined, opts: ChatOpts): Promise<ChatResult> =>
    ipcRenderer.invoke('chat:send', userInput, history, opts),
  retryChat: (opts: ChatOpts): Promise<ChatResult> => ipcRenderer.invoke('chat:retry', opts),
  cancelChat: (tabId: string): Promise<boolean> => ipcRenderer.invoke('chat:cancel', tabId),
  modelPicker: (): Promise<{ value: string; label: string; tier: string }[]> => ipcRenderer.invoke('models:picker'),
  roleCandidates: (): Promise<{ value: string; label: string; tier: string }[]> => ipcRenderer.invoke('roles:candidates'),
  media: {
    models: (kind: 'image' | 'video' | 'audio'): Promise<unknown[]> => ipcRenderer.invoke('media:models', kind),
    generate: (kind: 'image' | 'video' | 'audio', modelId: string, prompt: string): Promise<{ ok: boolean; path?: string; model?: string; modelId?: string; color?: string; note: string }> => ipcRenderer.invoke('media:generate', kind, modelId, prompt),
    site: (id: string, prompt?: string, external?: boolean): Promise<string | null> => ipcRenderer.invoke('media:site', id, prompt, !!external),
    geminiLogin: (): Promise<boolean> => ipcRenderer.invoke('media:gemini-login'),
    accounts: (): Promise<{ id: string; label: string; url: string; state: 'yes' | 'maybe' | 'no'; where: string; manual: boolean }[]> => ipcRenderer.invoke('media:accounts'),
    accountVerify: (id: string): Promise<'yes' | 'no' | 'unknown'> => ipcRenderer.invoke('media:account-verify', id),
    accountLogin: (id: string): Promise<string | null> => ipcRenderer.invoke('media:account-login', id),
    accountLogout: (id: string): Promise<boolean> => ipcRenderer.invoke('media:account-logout', id),
  accountMark: (id: string, state: 'yes' | 'no' | null): Promise<boolean> => ipcRenderer.invoke('media:account-mark', id, state),
    preview: (p: string): Promise<string> => ipcRenderer.invoke('media:preview', p),
    info: (p: string): Promise<{ name: string; size: number } | null> => ipcRenderer.invoke('media:info', p),
    open: (p: string, reveal?: boolean): Promise<boolean> => ipcRenderer.invoke('media:open', p, !!reveal)
  },
  check: {
    run: (kind: 'mcp' | 'tools' | 'connectors' | 'models') => ipcRenderer.invoke('check:run', kind),
    cancel: (kind: string): Promise<boolean> => ipcRenderer.invoke('check:cancel', kind),
    onItem: (cb: (kind: string, item: unknown) => void): (() => void) => {
      const h = (_e: unknown, kind: string, item: unknown): void => cb(kind, item)
      ipcRenderer.on('check:item', h)
      return () => ipcRenderer.removeListener('check:item', h)
    }
  },
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    set: (patch: unknown) => ipcRenderer.invoke('prefs:set', patch),
    testLocation: () => ipcRenderer.invoke('prefs:testLocation'),
    testVirusTotal: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('prefs:testVirusTotal')
  },
  learn: {
    get: () => ipcRenderer.invoke('learn:get'),
    forget: (kind: string, key: string): Promise<boolean> => ipcRenderer.invoke('learn:forget', kind, key),
    correct: (kind: string, value: string): Promise<boolean> => ipcRenderer.invoke('learn:correct', kind, value),
    reset: (): Promise<boolean> => ipcRenderer.invoke('learn:reset'),
    refreshSummary: (): Promise<string> => ipcRenderer.invoke('learn:refreshSummary')
  },
  spend: {
    get: (): Promise<boolean> => ipcRenderer.invoke('spend:get'),
    set: (on: boolean): Promise<boolean> => ipcRenderer.invoke('spend:set', on)
  },
  freeFirst: {
    get: (): Promise<'openrouter' | 'apinex'> => ipcRenderer.invoke('freeFirst:get'),
    set: (v: 'openrouter' | 'apinex'): Promise<'openrouter' | 'apinex'> => ipcRenderer.invoke('freeFirst:set', v)
  },
  apinex: {
    refresh: (): Promise<string[]> => ipcRenderer.invoke('apinex:refresh')
  },
  computer: {
    get: (): Promise<{ enabled: boolean; sessionAllowed: boolean; autoApprove: boolean }> => ipcRenderer.invoke('computer:get'),
    set: (on: boolean): Promise<{ enabled: boolean; sessionAllowed: boolean; autoApprove: boolean }> => ipcRenderer.invoke('computer:set', on),
    reset: (): Promise<{ enabled: boolean; sessionAllowed: boolean; autoApprove: boolean }> => ipcRenderer.invoke('computer:reset'),
    setAuto: (on: boolean): Promise<{ enabled: boolean; sessionAllowed: boolean; autoApprove: boolean; fullAccess: boolean }> => ipcRenderer.invoke('computer:setAuto', on),
    appsGet: (): Promise<{ defaults: string[]; extra: string[] }> => ipcRenderer.invoke('computer:apps:get'),
    appsSet: (l: string[]): Promise<{ defaults: string[]; extra: string[] }> => ipcRenderer.invoke('computer:apps:set', l),
    setFull: (on: boolean): Promise<{ enabled: boolean; sessionAllowed: boolean; autoApprove: boolean; fullAccess: boolean }> => ipcRenderer.invoke('computer:setFull', on)
  },
  android: {
    status: () => ipcRenderer.invoke('android:status'),
    start: () => ipcRenderer.invoke('android:start'),
    screenshot: () => ipcRenderer.invoke('android:screenshot'),
    tap: (x: number, y: number) => ipcRenderer.invoke('android:tap', x, y),
    key: (k: string) => ipcRenderer.invoke('android:key', k),
    text: (t: string) => ipcRenderer.invoke('android:text', t),
    swipe: (x1: number, y1: number, x2: number, y2: number, ms: number) =>
      ipcRenderer.invoke('android:swipe', x1, y1, x2, y2, ms),
    streamStart: () => ipcRenderer.invoke('android:stream-start'),
    streamStop: () => ipcRenderer.invoke('android:stream-stop'),
    touch: (action: number, x: number, y: number) => ipcRenderer.send('android:touch', action, x, y),
    scroll: (x: number, y: number, dy: number) => ipcRenderer.send('android:scroll', x, y, dy),
    onVideo: (cb: (chunk: Uint8Array) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, chunk: Uint8Array): void => cb(chunk)
      ipcRenderer.on('android:video', listener)
      return () => ipcRenderer.removeListener('android:video', listener)
    },
    onVideoEnd: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('android:video-end', listener)
      return () => ipcRenderer.removeListener('android:video-end', listener)
    }
  },
  onStream: (cb: (tabId: string, kind: 'chunk' | 'reset', text?: string) => void): (() => void) => {
    const h = (_e: unknown, tabId: string, k: 'chunk' | 'reset', t?: string): void => cb(tabId, k, t)
    ipcRenderer.on('chat:stream', h)
    return () => ipcRenderer.removeListener('chat:stream', h)
  },
  status: (): Promise<{ key: boolean; ollama: boolean; localMaster: boolean; mcpOn: number; mcpTotal: number; free: { count: number; limit: number; limited: boolean } }> =>
    ipcRenderer.invoke('status:get'),
  onProgress: (cb: (tabId: string, text: string) => void): (() => void) => {
    const h = (_e: unknown, tabId: string, t: string): void => cb(tabId, t)
    ipcRenderer.on('chat:progress', h)
    return () => ipcRenderer.removeListener('chat:progress', h)
  },
  getKey: (key: string): Promise<string> => ipcRenderer.invoke('keys:get', key),
  setKey: (key: string, value: string): Promise<boolean> =>
    ipcRenderer.invoke('keys:set', key, value),
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    get: (name: string) => ipcRenderer.invoke('skills:get', name),
    create: (name: string, content: string) => ipcRenderer.invoke('skills:create', name, content),
    delete: (name: string) => ipcRenderer.invoke('skills:delete', name),
    lint: (content: string): Promise<{ id: string; message: string }[]> => ipcRenderer.invoke('skills:lint', content),
    toggle: (name: string) => ipcRenderer.invoke('skills:toggle', name)
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    get: (name: string) => ipcRenderer.invoke('mcp:get', name),
    add: (server: unknown) => ipcRenderer.invoke('mcp:add', server),
    remove: (name: string) => ipcRenderer.invoke('mcp:remove', name),
    test: (name: string) => ipcRenderer.invoke('mcp:test', name),
    toggle: (name: string) => ipcRenderer.invoke('mcp:toggle', name),
    scan: () => ipcRenderer.invoke('mcp:scan'),
    scanPlugins: () => ipcRenderer.invoke('plugins:scan'),
    importPlugins: (ids: string[]) => ipcRenderer.invoke('plugins:import', ids),
    parse: (text: string) => ipcRenderer.invoke('mcp:parse', text),
    import: (servers: unknown) => ipcRenderer.invoke('mcp:import', servers)
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list'),
    toggle: (name: string) => ipcRenderer.invoke('tools:toggle', name),
    add: (tool: unknown) => ipcRenderer.invoke('tools:add', tool),
    remove: (name: string) => ipcRenderer.invoke('tools:remove', name)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    detectLocal: () => ipcRenderer.invoke('models:detectLocal'),
    setPosition: (id: string, last: boolean) => ipcRenderer.invoke('models:setPosition', id, last),
    setKey: (id: string, key: string) => ipcRenderer.invoke('models:setKey', id, key),
    add: (m: unknown) => ipcRenderer.invoke('models:add', m),
    remove: (id: string) => ipcRenderer.invoke('models:remove', id),
    toggle: (id: string) => ipcRenderer.invoke('models:toggle', id),
    setPrice: (id: string, pin: string, pout: string) => ipcRenderer.invoke('models:setPrice', id, pin, pout),
    test: (id: string) => ipcRenderer.invoke('models:test', id),
    fetchRemote: (id: string, all?: boolean) => ipcRenderer.invoke('models:fetchRemote', id, all),
    importRemote: (id: string, items: (string | { id: string; free: boolean })[]) => ipcRenderer.invoke('models:importRemote', id, items),
    ollama: {
      status: () => ipcRenderer.invoke('ollama:status'),
      start: () => ipcRenderer.invoke('ollama:start'),
      openDownload: () => ipcRenderer.invoke('ollama:openDownload'),
      pull: (name: string) => ipcRenderer.invoke('ollama:pull', name),
      delete: (name: string) => ipcRenderer.invoke('ollama:delete', name),
      setChatModel: (name: string | null): Promise<string | null> => ipcRenderer.invoke('ollama:setChatModel', name),
      onProgress: (cb: (p: { model: string; status: string; percent: number; total?: number; completed?: number }) => void) => {
        const handler = (_e: unknown, p: { model: string; status: string; percent: number; total?: number; completed?: number }): void => cb(p)
        ipcRenderer.on('ollama:progress', handler)
        return () => ipcRenderer.removeListener('ollama:progress', handler)
      }
    }
  },
  providers: {
    check: (p: 'openai' | 'anthropic' | 'gemini' | 'openrouter'): Promise<{ ok: boolean; message: string; models: string[] }> => ipcRenderer.invoke('provider:check', p)
  },
  platforms: {
    overview: (freeOnly?: boolean) => ipcRenderer.invoke('platforms:overview', freeOnly),
    pull: (id: string) => ipcRenderer.invoke('platforms:pull', id),
    add: (name: string, baseURL: string, apiKey: string) => ipcRenderer.invoke('platforms:add', name, baseURL, apiKey)
  },
  hf: {
    free: (force?: boolean) => ipcRenderer.invoke('hf:free', force === true),
    models: (): Promise<{ ok: boolean; error?: string; total: number; models: { id: string; providers: string[]; recommended: boolean }[] }> => ipcRenderer.invoke('hf:models'),
    getModel: (): Promise<string> => ipcRenderer.invoke('hf:getModel'),
    setModel: (id: string): Promise<boolean> => ipcRenderer.invoke('hf:setModel', id),
    testModel: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('hf:testModel', id)
  },
  freeProbe: {
      list: (): Promise<{ ok: boolean; error?: string; models: { id: string; ctx: number; created: string }[] }> => ipcRenderer.invoke('freeprobe:list'),
      results: (): Promise<{ id: string; ok: boolean; score: number; secs: number; tool: boolean; arabic: boolean | null; note: string; at: string }[]> => ipcRenderer.invoke('freeprobe:results'),
      test: (id: string): Promise<{ id: string; ok: boolean; score: number; secs: number; tool: boolean; arabic: boolean | null; note: string; at: string } | null> => ipcRenderer.invoke('freeprobe:test', id),
      status: (): Promise<{ pinned: string | null; since: string | null; suggestion: { model: string; current: string; newScore: number; oldScore: number; at: string } | null; lastCheck: number; current: string }> => ipcRenderer.invoke('freeprobe:status'),
      evaluate: (): Promise<unknown> => ipcRenderer.invoke('freeprobe:evaluate'),
      apply: (id: string): Promise<boolean> => ipcRenderer.invoke('freeprobe:apply', id),
      dismiss: (): Promise<boolean> => ipcRenderer.invoke('freeprobe:dismiss'),
      unpin: (): Promise<boolean> => ipcRenderer.invoke('freeprobe:unpin'),
      checkNow: (): Promise<boolean> => ipcRenderer.invoke('freeprobe:checkNow')
    },
      connectors: {
    list: () => ipcRenderer.invoke('connectors:list'),
    active: (load?: boolean) => ipcRenderer.invoke('connectors:active', load),
    connect: (id: string) => ipcRenderer.invoke('connectors:connect', id),
    setup: (id: string, values: string[]) => ipcRenderer.invoke('connectors:setup', id, values),
    test: (id: string) => ipcRenderer.invoke('connectors:test', id),
    disconnect: (id: string) => ipcRenderer.invoke('connectors:disconnect', id),
    onCode: (cb: (id: string, code: string, url: string) => void) => {
      const h = (_e: unknown, id: string, code: string, url: string): void => cb(id, code, url)
      ipcRenderer.on('connectors:code', h)
      return () => ipcRenderer.removeListener('connectors:code', h)
    }
  },
  app: {
    about: () => ipcRenderer.invoke('app:about'),
    show: (): Promise<void> => ipcRenderer.invoke('app:show'),
    flash: (): Promise<void> => ipcRenderer.invoke('app:flash')
  },
  attach: {
    pick: (projectId?: string | null) => ipcRenderer.invoke('attach:pick', projectId ?? null),
    prepare: (paths: string[], projectId?: string | null) => ipcRenderer.invoke('attach:prepare', paths, projectId ?? null),
    savePasted: (name: string, data: ArrayBuffer, projectId?: string | null) => ipcRenderer.invoke('attach:savePasted', name, data, projectId ?? null),
    pathFor: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  accounts: {
    get: () => ipcRenderer.invoke('accounts:get'),
    setEmail: (v: string) => ipcRenderer.invoke('accounts:setEmail', v),
    setWrite: (server: string, on: boolean) => ipcRenderer.invoke('accounts:setWrite', server, on),
    google: (action: 'connect' | 'test') => ipcRenderer.invoke('accounts:google', action),
    googleDisconnect: () => ipcRenderer.invoke('accounts:googleDisconnect'),
    googleCreds: () => ipcRenderer.invoke('accounts:googleCreds'),
    googleSetup: (idOrJson: string, secret: string) => ipcRenderer.invoke('accounts:googleSetup', idOrJson, secret)
  },
  masterMemory: {
    get: () => ipcRenderer.invoke('mm:get'),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('mm:update', id, patch),
    clearGeneral: () => ipcRenderer.invoke('mm:clearGeneral')
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    save: (e: { id?: string; title: string; content: string; enabled?: boolean }) => ipcRenderer.invoke('memory:save', e),
    delete: (id: string) => ipcRenderer.invoke('memory:delete', id),
    toggle: (id: string) => ipcRenderer.invoke('memory:toggle', id),
    import: (entries: { title: string; content: string }[], source?: string) =>
      ipcRenderer.invoke('memory:import', entries, source),
    preview: () => ipcRenderer.invoke('memory:preview')
  },
  catalog: {
    list: () => ipcRenderer.invoke('catalog:list'),
    test: () => ipcRenderer.invoke('catalog:test'),
    fetch: () => ipcRenderer.invoke('catalog:fetch'),
    setEnabled: (ids: string[], on: boolean) => ipcRenderer.invoke('catalog:setEnabled', ids, on),
    move: (id: string, dir: 'up' | 'down') => ipcRenderer.invoke('catalog:move', id, dir),
    reset: (): Promise<number> => ipcRenderer.invoke('catalog:reset')
  },
  gemini: {
    list: (): Promise<{ ok: boolean; error?: string; models: { id: string; added: boolean }[] }> => ipcRenderer.invoke('gemini:list'),
    import: (ids: string[]): Promise<number> => ipcRenderer.invoke('gemini:import', ids)
  },
  hosts: {
    get: (): Promise<Record<string, { value: string; default: string; custom: boolean }>> => ipcRenderer.invoke('hosts:get'),
    set: (id: string, url: string): Promise<{ ok: boolean; error?: string; value: string }> => ipcRenderer.invoke('hosts:set', id, url)
  },
  schedules: {
    list: () => ipcRenderer.invoke('schedules:list'),
    add: (t: unknown) => ipcRenderer.invoke('schedules:add', t),
    update: (id: string, p: unknown) => ipcRenderer.invoke('schedules:update', id, p),
    remove: (id: string) => ipcRenderer.invoke('schedules:remove', id),
    run: (id: string) => ipcRenderer.invoke('schedules:run', id)
  },
  engineAccounts: {
    status: () => ipcRenderer.invoke('accounts:status'),
    login: (k: string) => ipcRenderer.invoke('accounts:login', k)
  },
  agentMode: {
    get: () => ipcRenderer.invoke('agentMode:get'),
    set: (v: boolean) => ipcRenderer.invoke('agentMode:set', v)
  },
  claudeAcct: {
    get: () => ipcRenderer.invoke('claudeAcct:get'),
    set: (p: { active?: string; auto?: boolean }) => ipcRenderer.invoke('claudeAcct:set', p),
    login: () => ipcRenderer.invoke('claudeAcct:login')
  },
  usage: {
    series: () => ipcRenderer.invoke('usage:series')
  },
  claudeUsage: {
    get: () => ipcRenderer.invoke('claudeUsage:get'),
    cap: (v: { capRuns?: number; capMinutes?: number }) => ipcRenderer.invoke('claudeUsage:cap', v)
  },
  roles: {
    get: () => ipcRenderer.invoke('roles:get'),
    set: (v: Record<string, string>) => ipcRenderer.invoke('roles:set', v)
  },
  effort: {
    get: () => ipcRenderer.invoke('effort:get'),
    set: (v: string) => ipcRenderer.invoke('effort:set', v)
  },
  projects: {
    setConfidential: (id: string, on: boolean) => ipcRenderer.invoke('projects:setConfidential', id, on),
    list: () => ipcRenderer.invoke('projects:list'),
    files: (id: string) => ipcRenderer.invoke('projects:files', id),
    add: (dir: string) => ipcRenderer.invoke('projects:add', dir),
    pick: () => ipcRenderer.invoke('projects:pick'),
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id),
    setActive: (id: string | null) => ipcRenderer.invoke('projects:setActive', id)
  },
  // F28: side browser panel. Its page has no preload, so only this main window can call these.
  side: {
    open: (url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => ipcRenderer.invoke('side:open', url),
    navigate: (url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => ipcRenderer.invoke('side:navigate', url),
    close: (): Promise<SideStateInfo> => ipcRenderer.invoke('side:close'),
    back: (): Promise<SideStateInfo> => ipcRenderer.invoke('side:back'),
    reload: (): Promise<SideStateInfo> => ipcRenderer.invoke('side:reload'),
    setWidth: (w: number): Promise<SideStateInfo> => ipcRenderer.invoke('side:setWidth', w),
    setOverlay: (on: boolean): Promise<SideStateInfo> => ipcRenderer.invoke('side:setOverlay', on),
    clearData: (): Promise<boolean> => ipcRenderer.invoke('side:clearData'),
    clearService: (id: string): Promise<boolean> => ipcRenderer.invoke('side:clearService', id),
  openFile: (): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> => ipcRenderer.invoke('side:openFile'),
  savePage: (kind: 'html' | 'pdf' | 'png'): Promise<{ ok: boolean; error?: string; cancelled?: boolean; path?: string }> => ipcRenderer.invoke('side:savePage', kind),
  viewInfo: (): Promise<SideViewInfo> => ipcRenderer.invoke('side:viewInfo'),
  zoom: (dir: 1 | -1 | 0): Promise<SideViewInfo> => ipcRenderer.invoke('side:zoom', dir),
  setFont: (font: string): Promise<SideViewInfo> => ipcRenderer.invoke('side:font', font),
  toggleReader: (): Promise<SideViewInfo> => ipcRenderer.invoke('side:reader'),
  toggleBookmark: (): Promise<SideViewInfo> => ipcRenderer.invoke('side:bookmarkToggle'),
  importList: (): Promise<SideImportSource[]> => ipcRenderer.invoke('side:importList'),
  importRun: (id: string, what: { history: boolean; bookmarks: boolean }): Promise<{ ok: boolean; error?: string; history?: number; bookmarks?: number }> => ipcRenderer.invoke('side:importRun', id, what),
  suggest: (q: string): Promise<Array<{ url: string; title: string; bookmark: boolean }>> => ipcRenderer.invoke('side:suggest', q),
  libraryStats: (): Promise<{ history: number; bookmarks: number; importedAt: number }> => ipcRenderer.invoke('side:libraryStats'),
  libraryClear: (): Promise<boolean> => ipcRenderer.invoke('side:libraryClear'),
    state: (): Promise<SideStateInfo> => ipcRenderer.invoke('side:state'),
    onChanged: (cb: (s: SideStateInfo) => void): (() => void) => {
      const h = (_e: unknown, s: SideStateInfo): void => cb(s)
      ipcRenderer.on('side:changed', h)
      return () => ipcRenderer.removeListener('side:changed', h)
    }
  },
  files: {
    exists: (paths: string[]): Promise<boolean[]> => ipcRenderer.invoke('file:exists', paths),
    preview: (p: string) => ipcRenderer.invoke('file:preview', p),
    open: (p: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('file:open', p),
    reveal: (p: string): Promise<boolean> => ipcRenderer.invoke('file:reveal', p)
  },
  report: {
    tasks: () => ipcRenderer.invoke('report:tasks'),
    export: (csv: string) => ipcRenderer.invoke('report:export', csv),
    budget: (v?: number) => ipcRenderer.invoke('report:budget', v)
  },
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    set: (enabled: boolean) => ipcRenderer.invoke('update:set', enabled),
    check: () => ipcRenderer.invoke('update:check'),
    now: () => ipcRenderer.invoke('update:now'),
    later: () => ipcRenderer.invoke('update:later'),
    onPrompt: (cb: (p: { latest?: string; current: string; url?: string }) => void): (() => void) => {
      const h = (_e: unknown, p: { latest?: string; current: string; url?: string }): void => cb(p)
      ipcRenderer.on('update:prompt', h)
      return () => ipcRenderer.removeListener('update:prompt', h)
    },
    onProgress: (cb: (p: { stage: string; percent?: number; message?: string }) => void): (() => void) => {
      const h = (_e: unknown, p: { stage: string; percent?: number; message?: string }): void => cb(p)
      ipcRenderer.on('update:progress', h)
      return () => ipcRenderer.removeListener('update:progress', h)
    },
    open: (url: string) => ipcRenderer.invoke('update:open', url)
  },
  transfer: {
    export: (sel: unknown, password: string) => ipcRenderer.invoke('transfer:export', sel, password),
    import: (password: string) => ipcRenderer.invoke('transfer:import', password)
  },
  security: { status: () => ipcRenderer.invoke('security:status') },
  orb: {
    state: (s: string): void => ipcRenderer.send('orb:state', s)
  },
  wake: {
    start: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('wake:start'),
    audio: (b: Uint8Array): void => ipcRenderer.send('wake:audio', b),
    stop: (): Promise<boolean> => ipcRenderer.invoke('wake:stop'),
    onEvent: (cb: (ev: { type: string }) => void): (() => void) => {
      const h = (_e: unknown, ev: { type: string }): void => cb(ev)
      ipcRenderer.on('wake:event', h)
      return () => ipcRenderer.removeListener('wake:event', h)
    },
  },
  live: {
    available: (): Promise<boolean> => ipcRenderer.invoke('live:available'),
    start: (): Promise<{ ok: boolean; model?: string; error?: string }> => ipcRenderer.invoke('live:start'),
    audio: (b64: string): void => ipcRenderer.send('live:audio', b64),
    toolResponse: (id: string, name: string, result: string): void => ipcRenderer.send('live:toolResponse', { id, name, result }),
    stop: (): Promise<boolean> => ipcRenderer.invoke('live:stop'),
    onEvent: (cb: (ev: { type: string; [k: string]: unknown }) => void): (() => void) => {
      const h = (_e: unknown, ev: { type: string; [k: string]: unknown }): void => cb(ev)
      ipcRenderer.on('live:event', h)
      return () => ipcRenderer.removeListener('live:event', h)
    },
  },
  translate: {
    available: (): Promise<boolean> => ipcRenderer.invoke('translate:available'),
    start: (target: string, echo: boolean): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('translate:start', target, echo),
    audio: (b64: string): void => ipcRenderer.send('translate:audio', b64),
    stop: (): Promise<boolean> => ipcRenderer.invoke('translate:stop'),
    onEvent: (cb: (ev: { type: string; [k: string]: unknown }) => void): (() => void) => {
      const h = (_e: unknown, ev: { type: string; [k: string]: unknown }): void => cb(ev)
      ipcRenderer.on('translate:event', h)
      return () => ipcRenderer.removeListener('translate:event', h)
    },
  },
  voice: {
    speak: (text: string): Promise<{ ok: boolean; url?: string; note?: string; error?: string }> => ipcRenderer.invoke('voice:speak', text),
    suaadStart: (text: string): Promise<SpeechPartResult> => ipcRenderer.invoke('voice:suaadStart', text),
    suaadNext: (id: string): Promise<SpeechPartResult> => ipcRenderer.invoke('voice:suaadNext', id),
    suaadStop: (id: string): Promise<boolean> => ipcRenderer.invoke('voice:suaadStop', id),
    transcribe: (data: ArrayBuffer): Promise<{ ok: boolean; text?: string; error?: string }> => ipcRenderer.invoke('voice:transcribe', data),
    warm: (): Promise<boolean> => ipcRenderer.invoke('voice:warm')
  },
  nb: {
    list: (): Promise<{ id: string; title: string; at: number; sources: number; notes: number }[]> => ipcRenderer.invoke('nb:list'),
    get: (id: string) => ipcRenderer.invoke('nb:get', id),
    create: (title: string) => ipcRenderer.invoke('nb:create', title),
    rename: (id: string, title: string): Promise<boolean> => ipcRenderer.invoke('nb:rename', id, title),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('nb:delete', id),
    addFiles: (id: string, paths?: string[]) => ipcRenderer.invoke('nb:addFiles', id, paths),
    addText: (id: string, name: string, text: string) => ipcRenderer.invoke('nb:addText', id, name, text),
    addLink: (id: string, url: string) => ipcRenderer.invoke('nb:addLink', id, url),
    removeSource: (id: string, sid: string) => ipcRenderer.invoke('nb:removeSource', id, sid),
    driveStatus: (): Promise<{ client: boolean; connected: boolean }> => ipcRenderer.invoke('nb:driveStatus'),
    driveImportClient: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('nb:driveImportClient'),
    driveConnect: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('nb:driveConnect'),
    driveDisconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('nb:driveDisconnect'),
    driveSearch: (q: string): Promise<{ ok: boolean; error?: string; files: { id: string; name: string; mime: string; modified: string }[] }> => ipcRenderer.invoke('nb:driveSearch', q),
    driveAdd: (id: string, f: { id: string; name: string; mime: string }) => ipcRenderer.invoke('nb:driveAdd', id, f),
    ask: (id: string, question: string) => ipcRenderer.invoke('nb:ask', id, question),
    generate: (id: string, kind: string, focus: string) => ipcRenderer.invoke('nb:generate', id, kind, focus),
    deleteNote: (id: string, noteId: string) => ipcRenderer.invoke('nb:deleteNote', id, noteId),
    exportNote: (id: string, noteId: string): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('nb:export', id, noteId),
    audio: (id: string, noteId: string): Promise<{ ok: boolean; url?: string; error?: string }> => ipcRenderer.invoke('nb:audio', id, noteId),
    slideAudio: (id: string, noteId: string): Promise<{ ok: boolean; urls?: string[]; engine?: string; error?: string }> => ipcRenderer.invoke('nb:slideAudio', id, noteId),
    saveVideo: (name: string, b64: string): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('nb:saveVideo', name, b64)
  },
  todo: {
    list: () => ipcRenderer.invoke('todo:list'),
    op: (op: unknown) => ipcRenderer.invoke('todo:op', op),
    onChanged: (cb: () => void): (() => void) => {
      const h = (): void => cb()
      ipcRenderer.on('todo:changed', h)
      return () => ipcRenderer.removeListener('todo:changed', h)
    }
  },
  agentMem: {
    get: () => ipcRenderer.invoke('agentmem:get'),
    set: (list: string[]) => ipcRenderer.invoke('agentmem:set', list)
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    save: (p: { id?: string; name: string; prompt: string; runOn: string; memory?: string; model?: string; tool?: string; schedule?: unknown; sources?: unknown }) => ipcRenderer.invoke('agents:save', p),
    remove: (id: string) => ipcRenderer.invoke('agents:remove', id),
    run: (id: string, task: string) => ipcRenderer.invoke('agents:run', id, task)
  },
  gate: {
    get: () => ipcRenderer.invoke('gate:get'),
    set: (p: { enabled?: boolean; url?: string; key?: string }) => ipcRenderer.invoke('gate:set', p),
    test: () => ipcRenderer.invoke('gate:test'),
    feed: () => ipcRenderer.invoke('gate:feed'),
    linkMail: (src: string) => ipcRenderer.invoke('gate:linkMail', src)
  },
  telegram: {
    get: () => ipcRenderer.invoke('telegram:get'),
    set: (p: { enabled?: boolean; chatId?: string; minSeconds?: number; token?: string; inbound?: boolean }) => ipcRenderer.invoke('telegram:set', p),
    clearToken: () => ipcRenderer.invoke('telegram:clearToken'),
    detect: () => ipcRenderer.invoke('telegram:detect'),
    test: () => ipcRenderer.invoke('telegram:test')
  },
  remote: {
    get: () => ipcRenderer.invoke('remote:get'),
    set: (p: unknown) => ipcRenderer.invoke('remote:set', p),
    pairStart: () => ipcRenderer.invoke('remote:pairStart'),
    pairAnswer: (ok: boolean) => ipcRenderer.invoke('remote:pairAnswer', ok),
    pairCancel: () => ipcRenderer.invoke('remote:pairCancel'),
    revoke: (id: string) => ipcRenderer.invoke('remote:revoke', id),
    benchApprove: (title: string, detail: string) => ipcRenderer.invoke('remote:benchApprove', title, detail),
    onEvent: (cb: (e: unknown) => void) => {
      const h = (_e: unknown, ev: unknown): void => cb(ev)
      ipcRenderer.on('remote:event', h)
      return () => ipcRenderer.removeListener('remote:event', h)
    }
  },
  conversations: {
    search: (q: string): Promise<{ id: string; snippet: string }[]> => ipcRenderer.invoke('conv:search', q),
    exportMd: (id: string): Promise<{ ok: boolean; error?: string; path?: string }> => ipcRenderer.invoke('conv:export', id),
    list: () => ipcRenderer.invoke('conv:list'),
    get: (id: string) => ipcRenderer.invoke('conv:get', id),
    save: (conv: unknown) => ipcRenderer.invoke('conv:save', conv),
    delete: (id: string) => ipcRenderer.invoke('conv:delete', id),
    pin: (id: string) => ipcRenderer.invoke('conv:pin', id),
    setProject: (id: string, projectId: string | null): Promise<boolean> => ipcRenderer.invoke('conv:setProject', id, projectId),
    rename: (id: string, title: string) => ipcRenderer.invoke('conv:rename', id, title),
    onChanged: (cb: () => void) => {
      const h = (): void => cb()
      ipcRenderer.on('conv:changed', h)
      return () => ipcRenderer.removeListener('conv:changed', h)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
