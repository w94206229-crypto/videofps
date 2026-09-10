/*
 * P2P Media Plugin 1.0.0 - dependency-free classic script.
 * Media belongs to RTP, never to a DataChannel. HostAdapter owns all PCs.
 * See README.md for the adapter contract and browser/security requirements.
 */
(function (global) {
  'use strict';
  const VERSION = '1.0.0';
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
  const live = t => t && t.readyState === 'live';
  const stopStream = s => s?.getTracks().forEach(t => t.stop());
  const PRESETS = Object.freeze({
    low: {size: 240, frameRate: 15, maxBitrate: 200000},
    default: {size: 360, frameRate: 24, maxBitrate: 400000},
    high: {size: 480, frameRate: 24, maxBitrate: 650000}
  });
  const audioDefaults = {echoCancellation: true, noiseSuppression: true, autoGainControl: true};
  function quality(value) {
    const v = typeof value === 'string' ? PRESETS[value] : value;
    if (!v) throw new TypeError('Unknown video quality');
    return {size: Math.round(clamp(v.size ?? 360, 160, 480) / 2) * 2,
      frameRate: clamp(v.frameRate ?? 24, 5, 24),
      maxBitrate: clamp(v.maxBitrate ?? 400000, 80000, 700000)};
  }
  function errorText(e, device = '设备') {
    const messages = {
      NotAllowedError: '权限未获允许。请检查地址栏的站点权限，再点击重试。',
      PermissionDeniedError: '权限未获允许。修改站点权限后可再次开启。',
      NotFoundError: '未找到可用设备；连接设备后可再次开启。',
      DevicesNotFoundError: '未找到可用设备。',
      NotReadableError: '设备被其他程序占用或暂时不可读；释放后重试。',
      TrackStartError: '设备无法启动；关闭占用设备的程序后重试。',
      OverconstrainedError: '所选设备或采集规格不可用，请重新选择。',
      SecurityError: '浏览器安全策略阻止采集；请使用 HTTPS 或 localhost。',
      AbortError: '设备启动已取消，可再次尝试。'
    };
    return device + '：' + (messages[e?.name] || String(e?.message || e).slice(0, 180));
  }
  class Events {
    constructor() { this.listeners = new Map(); }
    on(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
      return () => this.listeners.get(type)?.delete(fn);
    }
    emit(type, detail) {
      for (const fn of this.listeners.get(type) || []) {
        try { fn(detail); } catch (e) { console.warn('[P2PMedia event]', e); }
      }
    }
  }

  // Exactly one instance per current camera, NOT one instance per remote peer.
  class SquareVideoPipeline {
    constructor(config, focus, onChange, onError) {
      this.config = {...config}; this.focus = {...focus};
      this.onChange = onChange; this.onError = onError;
      this.track = null; this.raw = null; this.disposed = false;
      this.mode = 'off'; this.lastDraw = 0; this.frame = 0;
    }
    async start(raw, forceCanvas = false) {
      this.raw = raw;
      const video = this.video = document.createElement('video');
      video.muted = true; video.autoplay = true; video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:0;opacity:0;pointer-events:none';
      video.srcObject = new MediaStream([raw]); document.body.append(video);
      await new Promise((resolve, reject) => {
        let timer;
        const finish = err => {
          clearTimeout(timer); video.removeEventListener('loadeddata', ready);
          video.removeEventListener('error', failed); this.cancelStart = null;
          err ? reject(err) : resolve();
        };
        const ready = () => { if (video.videoWidth && video.videoHeight) finish(); };
        const failed = () => finish(new Error('摄像头预览初始化失败'));
        this.cancelStart = () => finish(new DOMException('Cancelled', 'AbortError'));
        video.addEventListener('loadeddata', ready); video.addEventListener('error', failed);
        timer = setTimeout(() => finish(new Error('摄像头未输出画面，请重试')), 10000);
        video.play().then(ready).catch(finish); ready();
      });
      if (this.disposed) throw new DOMException('Cancelled', 'AbortError');
      const s = raw.getSettings();
      if (!forceCanvas && s.width === this.config.size && s.height === this.config.size &&
          video.videoWidth === video.videoHeight) {
        this.track = raw; this.mode = 'native-square';
      } else this.useCanvas(false);
      this.onResize = () => {
        if (this.disposed || this.mode !== 'native-square') return;
        const s = raw.getSettings();
        if (s.width !== s.height || this.video.videoWidth !== this.video.videoHeight || s.width !== this.config.size) {
          try { this.useCanvas(true); } catch (e) { this.onError(e); }
        }
      };
      video.addEventListener('resize', this.onResize);
      this.watchdog = setInterval(() => {
        this.onResize();
        if (this.mode === 'canvas-square' && performance.now() - this.lastDraw > 180) this.draw();
      }, 200);
      return this.track;
    }
    useCanvas(notify = true) {
      if (this.disposed) return;
      if (!HTMLCanvasElement.prototype.captureStream) throw new Error('浏览器不支持方形视频采集，请更换支持 canvas.captureStream 的浏览器');
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', {alpha: false});
        if (!this.ctx) throw new Error('无法创建方形视频处理画布');
        this.canvas.width = this.canvas.height = this.config.size;
        this.mode = 'canvas-square'; this.draw();
        this.output = this.canvas.captureStream(24);
        this.track = this.output.getVideoTracks()[0];
        if (!this.track) throw new Error('无法创建方形视频轨道');
        this.track.contentHint = 'motion';
        this.schedule();
        if (notify) this.changePromise = Promise.resolve(this.onChange(this.track));
      }
    }
    draw() {
      if (this.disposed || !this.ctx || this.video.readyState < 2) return;
      const w = this.video.videoWidth, h = this.video.videoHeight;
      if (!w || !h) return;
      const now = performance.now();
      if (now - this.lastDraw < 1000 / this.config.frameRate - 2) return;
      this.lastDraw = now;
      const c = Math.min(w, h), sx = clamp(this.focus.x * w - c / 2, 0, w - c),
        sy = clamp(this.focus.y * h - c / 2, 0, h - c);
      this.ctx.drawImage(this.video, sx, sy, c, c, 0, 0, this.canvas.width, this.canvas.height);
      this.drawCount = (this.drawCount || 0) + 1;
    }
    schedule() {
      const tick = () => { if (this.disposed) return; this.draw(); this.schedule(); };
      if (this.video.requestVideoFrameCallback) this.frame = this.video.requestVideoFrameCallback(tick);
      else this.frame = requestAnimationFrame(tick);
    }
    async configure(config) {
      this.config = {...config};
      // Shield RTP from any temporary non-square device output during applyConstraints.
      this.useCanvas(true);
      await this.changePromise;
      this.canvas.width = this.canvas.height = config.size;
      this.lastDraw = 0; this.draw();
      try { await this.track.applyConstraints({frameRate: config.frameRate}); } catch (_) {}
      try { await this.raw.applyConstraints({width: {ideal: config.size}, height: {ideal: config.size},
        aspectRatio: {ideal: 1}, frameRate: {ideal: config.frameRate, max: config.frameRate}, resizeMode: 'crop-and-scale'}); } catch (_) {}
    }
    setFocus(focus) {
      this.focus = {x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1)};
      if (this.focus.x !== 0.5 || this.focus.y !== 0.5) this.useCanvas(true);
    }
    diagnostics() {
      const s = this.track?.getSettings() || {};
      return {mode: this.mode, width: s.width || this.canvas?.width || 0,
        height: s.height || this.canvas?.height || 0, frameRate: s.frameRate,
        rawWidth: this.raw?.getSettings().width, rawHeight: this.raw?.getSettings().height,
        processedFrames: this.drawCount || 0};
    }
    destroy() {
      if (this.disposed) return; this.disposed = true;
      this.cancelStart?.(); clearInterval(this.watchdog);
      if (this.video?.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frame);
      else cancelAnimationFrame(this.frame);
      stopStream(this.output);
      if (this.video) {
        this.video.removeEventListener('resize', this.onResize);
        this.video.pause(); this.video.srcObject = null; this.video.remove();
      }
      this.track = null; this.ctx = null; this.canvas = null; this.raw = null; this.mode = 'off';
    }
  }

  // A generation counter invalidates unresolved permission requests after OFF/leave.
  // A single serialized acquisition chain prevents overlapping hardware captures.
  class DeviceController {
    constructor(owner, kind) {
      this.owner = owner; this.kind = kind; this.track = null; this.stream = null;
      this.state = 'off'; this.generation = 0; this.desired = false;
      this.queue = Promise.resolve(); this.pending = null; this.deviceId = '';
    }
    changed() { this.owner.changed(); }
    enable() {
      if (this.owner.plugin.destroyed) return Promise.resolve(false);
      if (this.desired && this.pending) return this.pending;
      if (live(this.track)) {
        this.track.enabled = true; this.desired = true; this.state = 'active';
        this.changed(); return Promise.resolve(true);
      }
      this.desired = true; const token = ++this.generation;
      this.state = 'requesting'; this.changed();
      const task = async () => {
        if (token !== this.generation || !this.desired) return false;
        let stream = null, pipeline = null;
        try {
          if (!global.isSecureContext || !navigator.mediaDevices?.getUserMedia)
            throw new Error('音视频需要 HTTPS 或 localhost 安全页面；普通局域网 HTTP 地址无法采集');
          const config = this.owner.config;
          const constraints = this.kind === 'audio' ? {...this.owner.audioOptions} : {
            width: {ideal: config.size}, height: {ideal: config.size}, aspectRatio: {ideal: 1},
            frameRate: {ideal: config.frameRate, max: config.frameRate}, resizeMode: 'crop-and-scale', facingMode: 'user'
          };
          if (this.deviceId) { constraints.deviceId = {exact: this.deviceId}; delete constraints.facingMode; }
          stream = await navigator.mediaDevices.getUserMedia({[this.kind]: constraints});
          if (token !== this.generation || !this.desired) { stopStream(stream); return false; }
          const raw = stream.getTracks().find(t => t.kind === this.kind);
          if (!raw) throw new Error('设备没有返回可用轨道');
          if (this.kind === 'video') {
            pipeline = new SquareVideoPipeline(config, this.owner.focus,
              track => {
                if (this.owner.pipeline === pipeline && token === this.generation) {
                  this.owner.videoTrack = track; const replacing = this.owner.plugin.replaceAll('video', track);
                  this.changed(); return replacing;
                }
              }, e => { this.owner.plugin.notice(errorText(e, '摄像头')); this.disable(); });
            this.startingPipeline = pipeline;
            const square = await pipeline.start(raw);
            if (token !== this.generation || !this.desired) { pipeline.destroy(); stopStream(stream); return false; }
            this.owner.pipeline = pipeline; this.owner.videoTrack = square;
          }
          this.track = raw; this.stream = stream;
          raw.addEventListener('ended', () => {
            if (this.track !== raw) return;
            this.disable(); this.owner.plugin.notice((this.kind === 'audio' ? '麦克风' : '摄像头') + '已断开；设备恢复后可重新开启。');
          }, {once: true});
          raw.addEventListener('mute', () => this.changed());
          raw.addEventListener('unmute', () => this.changed());
          this.state = 'active';
          await this.owner.plugin.replaceAll(this.kind, this.kind === 'video' ? this.owner.videoTrack : raw);
          if (token !== this.generation) return false;
          if (this.kind === 'audio') this.owner.plugin.watchMicrophone(raw);
          this.changed(); this.owner.plugin.refreshDevices();
          this.owner.plugin.ui?.notice(this.kind === 'audio' ? '\u9ea6\u514b\u98ce\u5df2\u5f00\u542f\u3002\u70b9\u201c\u9759\u97f3\u201d\u53ef\u5feb\u901f\u95ed\u9ea6\uff0c\u8bbe\u7f6e\u5185\u53ef\u91ca\u653e\u8bbe\u5907\u3002' : '\u6444\u50cf\u5934\u5df2\u5f00\u542f\uff0c\u753b\u9762\u4f1a\u5728\u53d1\u9001\u524d\u7edf\u4e00\u5904\u7406\u4e3a\u65b9\u5f62\u3002');
          return true;
        } catch (e) {
          pipeline?.destroy(); stopStream(stream);
          if (token === this.generation) {
            this.track = null; this.stream = null; this.state = 'off'; this.desired = false;
            if (this.kind === 'video') { this.owner.pipeline = null; this.owner.videoTrack = null; }
            this.changed(); this.owner.plugin.notice(errorText(e, this.kind === 'audio' ? '麦克风' : '摄像头'));
            this.owner.plugin.emit(this.kind === 'audio' ? 'microphone-request-failed' : 'camera-request-failed', {name: e.name, message: e.message});
          }
          return false;
        } finally { if (this.startingPipeline === pipeline) this.startingPipeline = null; }
      };
      const promise = this.queue.catch(() => {}).then(task);
      this.queue = promise; this.pending = promise;
      promise.finally(() => { if (this.pending === promise) this.pending = null; });
      return promise;
    }
    mute() { if (live(this.track)) { this.track.enabled = false; this.state = 'muted'; this.changed(); } }
    unmute() { if (live(this.track)) { this.track.enabled = true; this.state = 'active'; this.changed(); return Promise.resolve(true); } return this.enable(); }
    disable() {
      ++this.generation; this.desired = false; this.state = 'off';
      this.startingPipeline?.destroy(); this.startingPipeline = null;
      stopStream(this.stream); this.track = null; this.stream = null;
      if (this.kind === 'video') {
        this.owner.pipeline?.destroy(); this.owner.pipeline = null; this.owner.videoTrack = null;
      } else this.owner.plugin.watchMicrophone(null);
      this.changed(); return this.owner.plugin.replaceAll(this.kind, null);
    }
    async switchDevice(id) { await this.disable(); this.deviceId = String(id || ''); return this.enable(); }
  }
  class LocalMediaManager {
    constructor(plugin, options) {
      this.plugin = plugin; this.config = quality(options.video || 'default');
      this.audioOptions = {...audioDefaults, ...options.audio}; this.focus = {x: 0.5, y: 0.5};
      this.audio = new DeviceController(this, 'audio'); this.camera = new DeviceController(this, 'video');
      this.videoTrack = null; this.pipeline = null;
    }
    changed() { this.plugin.localChanged(); }
    state() { return {audio: this.audio.state, video: this.camera.state,
      audioInterrupted: !!this.audio.track?.muted, videoInterrupted: !!this.camera.track?.muted}; }
    async setQuality(v) {
      this.config = quality(v);
      if (this.pipeline) await this.pipeline.configure(this.config);
      await this.plugin.applyQualities(); this.changed();
    }
    destroy() { this.audio.disable(); this.camera.disable(); }
  }

  // One negotiation controller is responsible for bootstrap AND subsequent SDP.
  // Manual bootstrap is gated until the game's authenticated DataChannel is ready.
  class NegotiationController {
    constructor(session) {
      this.s = session; this.pc = session.pc; this.active = false;
      this.makingOffer = false; this.ignoreOffer = false; this.settingRemoteAnswer = false;
      this.candidates = []; this.chain = Promise.resolve(); this.closed = false;
      this.offers = 0; this.answers = 0; this.collisions = 0;
      this.onNeeded = () => { this.negotiate().catch(e => this.s.report(e)); };
      this.onICE = e => {
        if (this.active && e.candidate) this.s.signal({candidate: e.candidate.toJSON()});
      };
      this.pc.addEventListener('negotiationneeded', this.onNeeded);
      this.pc.addEventListener('icecandidate', this.onICE);
    }
    serial(fn) {
      const job = this.chain.catch(() => {}).then(() => {
        if (!this.closed && this.pc.signalingState !== 'closed') return fn();
      });
      this.chain = job; return job;
    }
    async initialOffer() {
      return this.serial(async () => {
        this.makingOffer = true;
        try { await this.pc.setLocalDescription(await this.pc.createOffer()); ++this.offers; }
        finally { this.makingOffer = false; }
      });
    }
    async initialAnswer(description) {
      return this.serial(async () => {
        await this.pc.setRemoteDescription(description);
        this.s.reserve(); await this.s.attachLocal();
        await this.pc.setLocalDescription(await this.pc.createAnswer()); ++this.answers;
      });
    }
    acceptInitialAnswer(description) { return this.serial(() => this.pc.setRemoteDescription(description)); }
    activate() {
      if (this.active) return; this.active = true;
      if (!this.pc.localDescription && this.s.initiator) this.onNeeded();
    }
    negotiate() {
      if (!this.active || (!this.pc.remoteDescription && !this.s.initiator)) return Promise.resolve();
      return this.serial(async () => {
        if (this.pc.signalingState !== 'stable') return;
        this.makingOffer = true;
        try {
          await this.pc.setLocalDescription(); ++this.offers;
          this.s.signal({description: {type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp}});
        } finally { this.makingOffer = false; }
      });
    }
    receive(message) {
      return this.serial(async () => {
        if (message.description) {
          const d = message.description;
          if (!['offer', 'answer'].includes(d.type) || typeof d.sdp !== 'string' || d.sdp.length > 48000) return;
          const ready = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswer);
          const collision = d.type === 'offer' && !ready;
          if (collision) ++this.collisions;
          this.ignoreOffer = !this.s.polite && collision;
          if (this.ignoreOffer) return;
          this.settingRemoteAnswer = d.type === 'answer';
          try {
            // setRemoteDescription(offer) performs implicit rollback on polite peers.
            await this.pc.setRemoteDescription(d);
          } finally { this.settingRemoteAnswer = false; }
          this.s.reserve(); await this.s.attachLocal();
          for (const c of this.candidates.splice(0)) {
            try { await this.pc.addIceCandidate(c); } catch (e) { if (!this.ignoreOffer) this.s.report(e); }
          }
          if (d.type === 'offer') {
            await this.pc.setLocalDescription(); ++this.answers;
            this.s.signal({description: {type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp}});
          }
          await this.s.applyQuality();
        } else if (message.candidate && !this.ignoreOffer) {
          const c = message.candidate;
          if (typeof c.candidate !== 'string' || c.candidate.length > 4096) return;
          if (!this.pc.remoteDescription) { if (this.candidates.length < 64) this.candidates.push(c); return; }
          try { await this.pc.addIceCandidate(c); } catch (e) { if (!this.ignoreOffer) this.s.report(e); }
        }
      });
    }
    destroy() {
      this.closed = true; this.candidates.length = 0;
      this.pc.removeEventListener('negotiationneeded', this.onNeeded); this.pc.removeEventListener('icecandidate', this.onICE);
    }
  }

  class PeerMediaSession {
    constructor(plugin, id, pc, info) {
      this.plugin = plugin; this.id = String(id); this.pc = pc; this.info = info;
      this.initiator = !!info.initiator; this.polite = !!info.polite; this.token = info.sessionId;
      this.remote = new MediaStream(); this.remoteState = {audio: 'off', video: 'off'};
      this.trackOffs = [];
      this.closed = false; this.level = 0; this.badCount = 0; this.goodCount = 0;
      this.trackQueues = {audio: Promise.resolve(), video: Promise.resolve()};
      this.paramChain = Promise.resolve(); this.stats = {}; this.last = {};
      this.negotiation = new NegotiationController(this);
      this.trackListener = e => this.onTrack(e.track);
      this.stateListener = () => this.connectionChanged();
      pc.addEventListener('track', this.trackListener); pc.addEventListener('connectionstatechange', this.stateListener);
      pc.addEventListener('iceconnectionstatechange', this.stateListener);
      // The answerer reserves immediately AFTER SRD and BEFORE its answer.
      // Pre-adding answerer transceivers makes Chromium create duplicate m-lines.
      if (!info.deferReserve && (this.initiator || pc.remoteDescription || pc.localDescription)) this.reserve();
      for (const r of pc.getReceivers()) if (r.track) this.onTrack(r.track);
    }
    reserve() {
      for (const kind of ['audio', 'video']) {
        const key = kind + 'Transceiver';
        if (!this[key]) {
          this[key] = this.pc.getTransceivers().find(t => !t.stopped && t.receiver.track.kind === kind) ||
            this.pc.addTransceiver(kind, {direction: 'sendrecv'});
          if (this[key].direction !== 'sendrecv') this[key].direction = 'sendrecv';
        }
      }
    }
    attachLocal() {
      return Promise.all([this.replace('audio', this.plugin.local.audio.track), this.replace('video', this.plugin.local.videoTrack)]);
    }
    replace(kind, track) {
      const queue = this.trackQueues[kind].catch(() => {}).then(async () => {
        if (this.closed) return;
        const t = this[kind + 'Transceiver']; if (!t) return;
        // Read the newest desired local track, rather than resurrecting a queued old one.
        const current = kind === 'audio' ? this.plugin.local.audio.track : this.plugin.local.videoTrack;
        track = live(current) ? current : null;
        if (t.sender.track === track) return;
        try { await t.sender.replaceTrack(track); }
        catch (e) {
          if (e.name === 'InvalidModificationError' && track) {
            // The old negotiated codec envelope cannot carry the new track.
            await t.sender.replaceTrack(null);
            this.pc.removeTrack(t.sender);
            this.pc.addTrack(track, new MediaStream([track]));
            this[kind + 'Transceiver'] = this.pc.getTransceivers().find(x => x.sender.track === track);
            await this.negotiation.negotiate();
          } else if (!this.closed) this.report(e);
        }
      });
      this.trackQueues[kind] = queue;
      return queue.then(() => this.applyQuality());
    }
    signal(payload) {
      if (this.closed) return;
      this.plugin.adapter.sendSignal(this.id, {sessionId: this.token, payload});
    }
    activate() {
      if (this.closed || this.announced && this.negotiation.active) return;
      this.negotiation.activate(); this.attachLocal();
      if (!this.announced) { this.announced = true; this.sendState(); }
    }
    sendState() { if (this.negotiation.active) this.signal({state: this.plugin.local.state()}); }
    onTrack(track) {
      if (this.closed) return;
      for (const old of this.remote.getTracks()) if (old.kind === track.kind && old !== track) this.remote.removeTrack(old);
      if (!this.remote.getTracks().includes(track)) this.remote.addTrack(track);
      const update = () => { if (!this.closed) this.plugin.ui?.updatePeer(this); };
      track.addEventListener('mute', update); track.addEventListener('unmute', update);
      track.addEventListener('ended', update, {once: true});
      this.trackOffs.push(() => { track.removeEventListener('mute', update); track.removeEventListener('unmute', update); track.removeEventListener('ended', update); });
      this.plugin.ui?.updatePeer(this);
    }
    receive(payload) {
      if (payload.state) {
        const a = payload.state.audio, v = payload.state.video;
        if (['off', 'requesting', 'active', 'muted'].includes(a) && ['off', 'requesting', 'active'].includes(v)) {
          this.remoteState = {audio: a, video: v, audioInterrupted: !!payload.state.audioInterrupted, videoInterrupted: !!payload.state.videoInterrupted};
          this.plugin.ui?.updatePeer(this);
        }
        return Promise.resolve();
      }
      return this.negotiation.receive(payload);
    }
    connectionChanged() {
      if (this.closed) return;
      const state = this.pc.connectionState;
      if (state === 'connected') { this.retries = 0; clearTimeout(this.retryTimer); this.retryTimer = null; this.sendState(); this.applyQuality(); }
      else if (['failed', 'disconnected'].includes(state) && !this.retryTimer && this.negotiation.active) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.closed || this.pc.connectionState === 'connected') return;
          if ((this.retries || 0) >= 3) { this.plugin.notice('部分玩家直连失败；可点“重试连接”，或检查双方 STUN / TURN 配置。'); return; }
          this.retries = (this.retries || 0) + 1;
          this.restart();
        }, state === 'failed' ? 1500 : 4000);
      }
      this.plugin.ui?.updatePeer(this);
    }
    restart() {
      if (this.closed || !this.negotiation.active) return;
      try { this.pc.restartIce(); this.negotiation.negotiate().catch(e => this.report(e)); }
      catch (e) { this.report(e); }
    }
    report(e) {
      if (this.closed || e?.name === 'InvalidStateError' && this.pc.signalingState === 'closed') return;
      this.plugin.log('peer-error', {peer: this.id, name: e?.name, message: String(e?.message || e).slice(0, 170)});
    }
    applyQuality() {
      this.paramChain = this.paramChain.catch(() => {}).then(async () => {
        if (this.closed) return;
        for (const kind of ['audio', 'video']) {
          const sender = this[kind + 'Transceiver']?.sender;
          if (!sender || !this.pc.localDescription || !sender.track) continue;
          const p = sender.getParameters(); if (!p.encodings?.length) continue;
          if (kind === 'video') {
            const q = this.plugin.local.config, max = [q.maxBitrate, Math.min(q.maxBitrate, 280000), Math.min(q.maxBitrate, 160000), 80000][this.level];
            p.encodings[0].maxBitrate = max;
            p.encodings[0].maxFramerate = Math.min(q.frameRate, [24, 20, 12, 8][this.level]);
            p.encodings[0].scaleResolutionDownBy = Math.max(1, q.size / [q.size, 300, 240, 160][this.level]);
            p.encodings[0].active = this.level < 3;
            p.degradationPreference = 'balanced';
            this.stats.limitKbps = Math.round(max / 1000);
          } else p.encodings[0].maxBitrate = 32000;
          try { await sender.setParameters(p); }
          catch (e) {
            // Some engines implement the core limits but not degradationPreference.
            delete p.degradationPreference;
            try { await sender.setParameters(p); } catch (again) { this.report(again); }
          }
        }
      });
      return this.paramChain;
    }
    async pollStats() {
      if (this.closed || this.polling || this.pc.connectionState === 'closed') return;
      this.polling = true;
      try {
        const stats = await this.pc.getStats(); if (this.closed) return;
        let out, remote, incoming, pair;
        for (const r of stats.values()) {
          if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'video' && !r.isRemote) out = r;
          if (r.type === 'remote-inbound-rtp' && (r.kind || r.mediaType) === 'video') remote = r;
          if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio') incoming = r;
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
        }
        if (!pair) for (const r of stats.values()) if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
        const delta = out && this.last.out ? (out.timestamp - this.last.out.timestamp) / 1000 : 0;
        const kbps = delta > 0 ? Math.max(0, (out.bytesSent - this.last.out.bytesSent) * 8 / delta / 1000) : 0;
        let loss = 0;
        if (remote && this.last.remote && remote.id === this.last.remote.id) {
          const lost = Math.max(0, remote.packetsLost - this.last.remote.packetsLost);
          const received = Math.max(0, (remote.packetsReceived || 0) - (this.last.remote.packetsReceived || 0));
          const sent = Math.max(0, (out?.packetsSent || 0) - (this.last.out?.packetsSent || 0));
          loss = lost / Math.max(1, received + lost, sent);
        } else if (remote) loss = remote.fractionLost || 0;
        const rtt = (pair?.currentRoundTripTime ?? remote?.roundTripTime ?? 0) * 1000;
        const available = pair?.availableOutgoingBitrate;
        const buffered = this.plugin.adapter.getBufferedAmount?.(this.id) || 0;
        const route = pair && (stats.get(pair.localCandidateId)?.candidateType === 'relay' || stats.get(pair.remoteCandidateId)?.candidateType === 'relay') ? 'TURN' : pair ? 'DIRECT' : '--';
        let desired = loss > 0.25 || rtt > 1400 || buffered > 196608 || available !== undefined && available < 100000 ? 3 :
          loss > 0.10 || rtt > 700 || buffered > 98304 || available !== undefined && available < 240000 ? 2 :
          loss > 0.035 || rtt > 300 || buffered > 49152 || available !== undefined && available < 430000 ? 1 : 0;
        if (this.pc.connectionState !== 'connected') desired = this.level;
        if (desired > this.level) { this.goodCount = 0; if (++this.badCount >= 2) { this.level = desired; this.badCount = 0; await this.applyQuality(); } }
        else if (desired < this.level) { this.badCount = 0; if (++this.goodCount >= 4) { --this.level; this.goodCount = 0; await this.applyQuality(); } }
        else { this.badCount = 0; this.goodCount = 0; }
        Object.assign(this.stats, {quality: ['GOOD', 'FAIR', 'POOR', 'VIDEO PAUSED'][this.level], rtt: Math.round(rtt),
          loss: Math.round(loss * 1000) / 10, kbps: Math.round(kbps), route,
          sentWidth: out?.frameWidth || 0, sentHeight: out?.frameHeight || 0,
          framesEncoded: out?.framesEncoded || 0, audioLevel: incoming?.audioLevel || 0,
          availableKbps: available === undefined ? null : Math.round(available / 1000)});
        this.last = {out, remote}; this.plugin.ui?.updatePeer(this);
      } catch (e) { this.report(e); } finally { this.polling = false; }
    }
    destroy() {
      if (this.closed) return; this.closed = true;
      clearTimeout(this.retryTimer); this.negotiation.destroy();
      this.pc.removeEventListener('track', this.trackListener);
      this.pc.removeEventListener('connectionstatechange', this.stateListener);
      this.pc.removeEventListener('iceconnectionstatechange', this.stateListener);
      // Never close a host-owned PC or stop shared local tracks on peer departure.
      for (const kind of ['audio', 'video']) {
        try { this[kind + 'Transceiver']?.sender.replaceTrack(null).catch(() => {}); } catch (_) {}
      }
      for (const off of this.trackOffs) off(); this.trackOffs.length = 0;
      for (const t of this.remote.getTracks()) this.remote.removeTrack(t);
      this.plugin.ui?.removePeer(this.id);
    }
  }

  const css = `
:host{all:initial!important;position:fixed!important;inset:0 auto auto 0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;pointer-events:none!important;color:#ede9e0!important;font:12px/1.45 system-ui,"Microsoft YaHei",sans-serif!important;width:0!important;height:0!important;overflow:visible!important;color-scheme:dark}
:host::backdrop{background:transparent;pointer-events:none}
*,*::before,*::after{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer;color:#c4cecb;background:#26373c;border:1px solid #53645e;border-radius:7px;min-height:32px;padding:5px 9px;touch-action:manipulation}button:hover{background:#354c50}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #efb366;outline-offset:2px}button[aria-pressed=true]{color:#182328;background:#eab775;border-color:#efb366}button:disabled{opacity:.5;cursor:default}button svg{width:17px;height:17px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}button.icon{display:flex;align-items:center;justify-content:center;gap:6px}input,select{max-width:100%;accent-color:#edbb7d;min-width:0}select{background:#23373b;color:#e3e8df;border:1px solid #53645e;border-radius:5px;padding:5px;width:160px}input[type=range]{width:134px}label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#c4d0c8}small{font-size:10px;color:#9baeb0}[hidden]{display:none!important}
.dock{pointer-events:auto;width:min(318px,calc(100vw - 16px));max-height:calc(100dvh - 16px);display:flex;flex-direction:column;border:1px solid #78918b75;border-radius:13px;background:#132227f5;box-shadow:0 14px 42px #0007;overflow:hidden;user-select:none;contain:layout style;isolation:isolate}
header{padding:10px 11px;display:flex;align-items:center;gap:7px;background:#1e3034;touch-action:none;cursor:grab}header:active{cursor:grabbing}.brand{color:#efbf82;letter-spacing:1.8px;font-size:10px;font-weight:750}.subtitle{color:#9eb2b0;font-size:10px;letter-spacing:.3px}.header-copy{flex:1;min-width:0}.status-dot{width:6px;height:6px;background:#97c8b5;box-shadow:0 0 0 4px #97c8b517;border-radius:50%;margin-right:5px}header button{min-height:26px;width:27px;padding:0;border:0;background:#314548}
.body{overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:9px;min-height:0}.tiles{display:grid;grid-template-columns:1fr 1fr;gap:7px}.tile{aspect-ratio:1;min-width:0;position:relative;overflow:hidden;background:linear-gradient(145deg,#283b40,#192c31);border:1px solid #53666280;border-radius:8px;transition:border-color .12s}.tile.speaking{border-color:#b9dd9b;box-shadow:inset 0 0 0 1px #b9dd9b}.tile video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#14242a}.tile.local video{transform:scaleX(-1)}.avatar{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;pointer-events:none}.initial{font-size:32px;font-weight:650;color:#d7c8aa;font-family:ui-monospace,monospace}.tile-note{font-size:10px;color:#a9bab5;max-width:90%;text-align:center}.tilebar{position:absolute;bottom:0;left:0;right:0;padding:19px 7px 6px;display:flex;align-items:center;gap:5px;background:linear-gradient(transparent,#07191ee8);font-size:10px}.peer-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.mic-dot{color:#afdab3;font-size:10px}.peer-quality{position:absolute;right:5px;top:5px;padding:2px 5px;font:8px ui-monospace,monospace;background:#0c2028bf;color:#bce1d4;border-radius:3px}.tile details{position:absolute;right:5px;bottom:27px;z-index:2}.tile summary{list-style:none;cursor:pointer;color:#e5e9dc;padding:0 6px;border-radius:4px;background:#11242bad}.tile details[open]{left:5px;padding:5px;border-radius:5px;background:#152d33f5;border:1px solid #6b8278}.tile details[open] summary{text-align:right}.tile details label{font-size:9px;margin:4px 0}.tile details input[type=range]{width:68px}.tile details button{font-size:9px;min-height:24px;padding:2px 6px}.tile details .stats{font:8px/1.6 ui-monospace,monospace;color:#afc6c3;white-space:pre-line}
.controls{display:grid;grid-template-columns:1fr 1fr 36px 36px;gap:6px;margin-top:9px}.controls button{font-size:11px;padding:6px 4px}.controls button small{color:inherit}.notice{font-size:10px;line-height:1.6;color:#c7d3cb;padding:8px 2px 2px;overflow-wrap:anywhere;max-height:78px;overflow:auto}.notice.error{color:#f2c097}.unlock{width:100%;margin-top:7px;color:#ffdaa3;border-color:#ae8b5b;background:#423b2d}.settings{padding-top:10px;margin-top:10px;border-top:1px solid #596f6a60;display:grid;gap:9px}.setting-actions{display:flex;gap:6px;flex-wrap:wrap}.setting-actions button{font-size:10px}.hint{font-size:9px;color:#99b1ad;line-height:1.6}.footer{margin-top:7px;color:#8da5a2;font-size:9px;display:flex;justify-content:space-between}.collapsed .body{display:none}.collapsed{width:218px}.collapsed header{padding:9px 11px}.resume{width:100%;margin-top:8px;font-size:10px;background:#2b4241}.empty{border-style:dashed;opacity:.62}.empty .initial{font-size:21px;color:#92aaa3}
@media(max-height:500px){.dock:not(.collapsed){width:282px}.body{padding:7px}.tiles{gap:5px}.tile{aspect-ratio:1}.controls{margin-top:6px}header{padding:7px 9px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
`;
  const icons = {
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    camera: '<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 9 6-3v12l-6-3"/>',
    speaker: '<path d="M11 4 6 8H2v8h4l5 4zM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>'
  };
  function icon(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + icons[name] + '</svg>'; }
  class FloatingMediaUI {
    constructor(plugin, options = {}) {
      this.plugin = plugin; this.options = options; this.tiles = new Map();
      this.masterVolume = 1; this.outputMuted = false; this.hidden = false;
      this.state = {x: Math.max(8, innerWidth - 334), y: Math.min(142, innerHeight / 5), opacity: 0.85,
        collapsed: true, localVisible: true, width: 318};
      try {
        if (options.rememberPosition !== false) {
          const saved = JSON.parse(localStorage.getItem('p2p-media-ui-v1') || 'null');
          if (saved && typeof saved === 'object') {
            for (const k of ['x', 'y', 'opacity', 'width']) if (Number.isFinite(saved[k])) this.state[k] = saved[k];
            for (const k of ['collapsed', 'localVisible']) if (typeof saved[k] === 'boolean') this.state[k] = saved[k];
          }
        }
      } catch (_) {}
      this.state.opacity = clamp(options.opacity ?? this.state.opacity, 0.2, 1);
      const host = this.host = document.createElement('div'); host.id = 'p2p-media-overlay';
      this.root = host.attachShadow({mode: 'closed'});
      this.root.innerHTML = '<style>' + css + '</style>' + `
<section class="dock" role="region" aria-label="四人实时音视频通话">
<header id="drag" title="拖动通话窗口"><span class="status-dot"></span><div class="header-copy"><div class="brand">SQUAD COMMS / 小队通话</div><div class="subtitle" id="room-status">本地预览 · 未加入房间</div></div><button id="collapse" aria-label="展开通话窗口" title="展开 / 折叠">＋</button><button id="hide" aria-label="隐藏通话窗口" title="隐藏；Alt+C 可恢复">×</button></header>
<div class="body"><div class="tiles" id="tiles"></div>
<div class="controls"><button id="mic" class="icon" aria-pressed="false">${icon('mic')}<span>开麦</span></button><button id="cam" class="icon" aria-pressed="false">${icon('camera')}<span>摄像头</span></button><button id="speaker" class="icon" aria-label="静音所有通话音频" title="通话声音独立于游戏音量">${icon('speaker')}</button><button id="settings-toggle" class="icon" aria-label="通话设置" aria-expanded="false">${icon('settings')}</button></div>
<button class="unlock" id="unlock" hidden>点击播放朋友的声音</button>
<div class="notice" id="notice" role="status" aria-live="polite">默认不采集。点击开麦或摄像头后，才会请求对应权限。</div>
<div class="settings" id="settings" hidden>
<label>麦克风<select id="audio-device" aria-label="选择麦克风"><option value="">系统默认</option></select></label>
<label>摄像头<select id="video-device" aria-label="选择摄像头"><option value="">系统默认</option></select></label>
<label>发送画质<select id="quality" aria-label="发送画质"><option value="low">省流 · 240² / 15fps</option><option value="default" selected>标准 · 360² / 24fps</option><option value="high">清晰 · 480² / 24fps</option></select></label>
<label>通话音量<input id="master-volume" aria-label="通话音量" type="range" min="0" max="100" value="100"></label>
<label>窗口透明度 <input id="opacity" aria-label="通话窗口透明度" type="range" min="20" max="100" value="85"></label>
<label>窗口尺寸<input id="width" aria-label="通话窗口宽度" type="range" min="240" max="420" step="10" value="318"></label>
<label>本地预览<input id="local-visible" type="checkbox" checked></label>
<div class="setting-actions"><button id="hard-stop">释放麦克风</button><button id="devices-refresh">刷新设备</button><button id="retry">重试连接</button><button id="reset">重置位置</button><button id="diagnostics">导出诊断</button></div>
<div class="hint">“静音”保留麦克风；“释放麦克风”停止设备。隐藏窗口或预览不会关闭采集；离开房间会关闭设备。使用耳机可减少回声。</div>
</div>
<button class="resume" id="resume">返回游戏 / 捕获鼠标</button>
<div class="footer"><span id="pipeline">CAM OFF · RTP MEDIA</span><span>Alt+C 通话面板</span></div>
</div></section>`;
      this.$ = s => this.root.querySelector(s); this.dock = this.$('.dock');
      document.body.append(host);
      this.usePopover = typeof host.showPopover === 'function' && options.alwaysOnTop !== false;
      if (this.usePopover) host.setAttribute('popover', 'manual');
      this.offs = [];
      const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this.offs.push(() => target.removeEventListener(type, fn, opts)); };
      this.on = on;
      // Stop composed events before they reach any game listener on body/document/window.
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchmove', 'touchend', 'click', 'dblclick', 'wheel', 'contextmenu', 'keydown', 'keyup', 'keypress'])
        on(host, type, e => { e.stopPropagation(); if (type === 'contextmenu') e.preventDefault(); }, {passive: false});
      on(host, 'pointerdown', () => { plugin.adapter.releaseInput?.(); plugin.unlockAudio(); }, {capture: true});
      on(host, 'focusin', () => plugin.adapter.releaseInput?.(), {capture: true});
      on(this.$('#mic'), 'click', () => {
        if (plugin.local.audio.state === 'requesting') plugin.disableMicrophone();
        else if (plugin.local.audio.state === 'active') plugin.muteMicrophone();
        else plugin.enableMicrophone();
      });
      on(this.$('#cam'), 'click', () => plugin.local.camera.state === 'off' ? plugin.enableCamera() : plugin.disableCamera());
      on(this.$('#speaker'), 'click', () => { this.outputMuted = !this.outputMuted; this.applyVolumes(); this.$('#speaker').setAttribute('aria-pressed', String(this.outputMuted)); });
      on(this.$('#unlock'), 'click', () => plugin.unlockAudio());
      on(this.$('#collapse'), 'click', () => this.collapse(!this.state.collapsed));
      on(this.$('#hide'), 'click', () => this.hide());
      on(this.$('#settings-toggle'), 'click', () => {
        const pane = this.$('#settings'); pane.hidden = !pane.hidden;
        this.$('#settings-toggle').setAttribute('aria-expanded', String(!pane.hidden));
        if (!pane.hidden) plugin.refreshDevices(); this.constrain();
      });
      on(this.$('#opacity'), 'input', e => this.setOpacity(+e.target.value / 100));
      on(this.$('#width'), 'input', e => { this.state.width = +e.target.value; this.layout(); this.save(); });
      on(this.$('#master-volume'), 'input', e => { this.masterVolume = +e.target.value / 100; this.applyVolumes(); });
      on(this.$('#local-visible'), 'change', e => { this.state.localVisible = e.target.checked; this.updateLocal(); this.save(); });
      on(this.$('#quality'), 'change', e => plugin.setVideoQuality(e.target.value));
      on(this.$('#audio-device'), 'change', e => { plugin.local.audio.deviceId = e.target.value; if (plugin.local.audio.state !== 'off') plugin.switchMicrophone(e.target.value); });
      on(this.$('#video-device'), 'change', e => { plugin.local.camera.deviceId = e.target.value; if (plugin.local.camera.state !== 'off') plugin.switchCamera(e.target.value); });
      on(this.$('#hard-stop'), 'click', () => plugin.disableMicrophone());
      on(this.$('#devices-refresh'), 'click', () => plugin.refreshDevices());
      on(this.$('#reset'), 'click', () => this.resetPosition());
      on(this.$('#retry'), 'click', () => { for (const s of plugin.peers.values()) s.restart(); this.notice('正在尝试恢复直连。严格 NAT 可能需要双方配置 TURN。'); });
      on(this.$('#diagnostics'), 'click', () => plugin.exportDiagnostics());
      on(this.$('#resume'), 'click', () => { this.host.blur(); plugin.adapter.resumeGame?.(); });
      const handle = this.$('#drag');
      on(handle, 'pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault(); this.drag = {id: e.pointerId, x: e.clientX, y: e.clientY, sx: this.state.x, sy: this.state.y};
        handle.setPointerCapture(e.pointerId);
      });
      on(handle, 'pointermove', e => {
        if (!this.drag || this.drag.id !== e.pointerId) return;
        this.state.x = this.drag.sx + e.clientX - this.drag.x; this.state.y = this.drag.sy + e.clientY - this.drag.y; this.constrain();
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(handle, type, () => { if (this.drag) { this.drag = null; this.save(); } });
      on(global, 'resize', () => this.constrain());
      on(global.visualViewport || global, 'resize', () => this.constrain());
      on(global.visualViewport || global, 'scroll', () => this.constrain());
      on(document, 'fullscreenchange', () => { if (!this.hidden) this.raise(); this.constrain(); });
      this.resizeObserver = global.ResizeObserver ? new ResizeObserver(() => this.constrain()) : null;
      this.resizeObserver?.observe(this.dock);
      this.makeTile('local', '你', true);
      this.layout(); this.show(); this.updateLocal();
    }
    makeTile(id, name, local = false) {
      id = String(id); if (this.tiles.has(id)) return this.tiles.get(id);
      const el = document.createElement('div'); el.className = 'tile' + (local ? ' local' : '');
      el.dataset.peer = id;
      el.innerHTML = '<video autoplay playsinline muted></video><div class="avatar"><div class="initial"></div><span class="tile-note">未开摄像头</span></div><span class="peer-quality"></span><div class="tilebar"><span class="mic-dot">○</span><span class="peer-name"></span></div>' +
        (!local ? '<details><summary aria-label="玩家音视频设置">···</summary><label>音量<input type="range" min="0" max="100" value="100" aria-label="玩家音量"></label><button class="mute">静音</button> <button class="hide-video">隐藏画面</button><div class="stats"></div></details>' : '');
      const tile = {el, local, id, name, video: el.querySelector('video'), audio: null, volume: 1, muted: false, videoHidden: false};
      tile.video.muted = true;
      if (!local) {
        tile.audio = document.createElement('audio'); tile.audio.autoplay = true; tile.audio.setAttribute('playsinline', ''); el.append(tile.audio);
        el.querySelector('input').addEventListener('input', e => this.setRemoteVolume(id, +e.target.value / 100));
        el.querySelector('.mute').addEventListener('click', () => this.setRemoteMuted(id, !tile.muted));
        el.querySelector('.hide-video').addEventListener('click', () => this.setRemoteHidden(id, !tile.videoHidden));
      }
      el.querySelector('.peer-name').textContent = name;
      el.querySelector('.initial').textContent = local ? 'YOU' : name.slice(0, 2).toUpperCase();
      this.$('#tiles').append(el); this.tiles.set(id, tile); return tile;
    }
    setVideo(tile, track) {
      if (tile.track === track) return;
      tile.track = track;
      tile.video.srcObject = track ? new MediaStream([track]) : null;
      if (track) tile.video.play().catch(() => {});
    }
    updateLocal() {
      const local = this.plugin.local, s = local.state(), tile = this.tiles.get('local'); if (!tile) return;
      this.setVideo(tile, local.videoTrack);
      tile.video.hidden = s.video !== 'active' || !this.state.localVisible;
      tile.el.querySelector('.avatar').hidden = !tile.video.hidden;
      tile.el.querySelector('.tile-note').textContent = !this.state.localVisible && s.video === 'active' ? '本地预览已隐藏 · 仍在发送' : s.video === 'requesting' ? '等待摄像头授权' : '摄像头已关闭';
      tile.el.querySelector('.mic-dot').textContent = s.audio === 'active' ? '●' : '○';
      tile.el.querySelector('.peer-quality').textContent = s.audio === 'muted' ? 'MIC MUTED' : 'LOCAL';
      this.$('#mic span').textContent = {off: '开麦', active: '静音', muted: '取消静音', requesting: '取消申请'}[s.audio];
      this.$('#cam span').textContent = {off: '摄像头', active: '关视频', requesting: '取消申请'}[s.video];
      this.$('#mic').setAttribute('aria-pressed', String(s.audio === 'active'));
      this.$('#cam').setAttribute('aria-pressed', String(s.video === 'active'));
      this.$('#local-visible').checked = this.state.localVisible;
      const d = local.pipeline?.diagnostics();
      this.$('#pipeline').textContent = d ? d.width + '×' + d.height + ' · ' + (d.mode === 'native-square' ? '原生方形' : '统一裁切') : 'CAM OFF · RTP MEDIA';
      this.updateRoom();
    }
    updateRoom() {
      const peers = [...this.plugin.peers.values()], connected = peers.filter(s => s.pc.connectionState === 'connected').length;
      const room = this.plugin.adapter.getRoomInfo?.();
      this.$('#room-status').textContent = room?.active ? '房间 ' + (room.count || connected + 1) + '/4 · 直连 ' + connected + '/3' : '本地预览 · 未加入房间';
    }
    updatePeer(session) {
      if (session.closed) return;
      const name = session.info.name || 'P' + session.id;
      const t = this.makeTile(session.id, name), r = session.remoteState;
      t.name = name; t.el.querySelector('.peer-name').textContent = name;
      t.el.querySelector('.initial').textContent = name.slice(0, 2).toUpperCase();
      const vt = session.remote.getVideoTracks()[0], at = session.remote.getAudioTracks()[0];
      this.setVideo(t, vt || null);
      if (t.audioTrack !== at) {
        t.audioTrack = at; t.audio.srcObject = at ? new MediaStream([at]) : null;
        if (at) t.audio.play().catch(() => this.showUnlock());
      }
      const connected = session.pc.connectionState === 'connected';
      t.video.hidden = t.videoHidden || r.video !== 'active' || !live(vt) || !connected;
      t.el.querySelector('.avatar').hidden = !t.video.hidden;
      t.el.querySelector('.tile-note').textContent = !connected ? '连接中 / 可在设置重试' : t.videoHidden ? '画面已隐藏 · 声音继续' : r.video === 'requesting' ? '对方正在开启摄像头' : '对方未开摄像头';
      t.el.querySelector('.mic-dot').textContent = r.audio === 'active' ? '●' : r.audio === 'muted' ? '⊘' : '○';
      const stats = session.stats;
      t.el.classList.toggle('speaking', r.audio === 'active' && (stats.audioLevel || 0) > 0.025);
      t.el.querySelector('.peer-quality').textContent = connected ? stats.quality || 'CONNECTED' : session.pc.connectionState.toUpperCase();
      t.el.querySelector('.stats').textContent = (stats.route || '--') + ' · ' + (stats.rtt || 0) + 'ms · 丢包 ' + (stats.loss || 0) + '%\n上行 ' + (stats.kbps || 0) + 'kbps / ' + (stats.limitKbps || 400) + 'kbps\n发送 ' + (stats.sentWidth || 0) + '×' + (stats.sentHeight || 0);
      this.applyVolume(t); this.updateRoom();
    }
    removePeer(id) {
      const t = this.tiles.get(String(id)); if (!t) return;
      t.video.pause(); t.video.srcObject = null;
      if (t.audio) { t.audio.pause(); t.audio.srcObject = null; }
      t.el.remove(); this.tiles.delete(String(id)); this.updateRoom();
    }
    applyVolume(t) { if (t.audio) { t.audio.muted = this.outputMuted || t.muted; t.audio.volume = clamp(t.volume * this.masterVolume, 0, 1); } }
    applyVolumes() { for (const t of this.tiles.values()) this.applyVolume(t); }
    setRemoteVolume(id, n) { const t = this.tiles.get(String(id)); if (t) { t.volume = clamp(n, 0, 1); t.el.querySelector('input').value = Math.round(t.volume * 100); this.applyVolume(t); } }
    setRemoteMuted(id, muted) { const t = this.tiles.get(String(id)); if (t) { t.muted = muted; t.el.querySelector('.mute').textContent = muted ? '取消静音' : '静音'; this.applyVolume(t); } }
    setRemoteHidden(id, hidden) { const t = this.tiles.get(String(id)); if (t) { t.videoHidden = hidden; t.el.querySelector('.hide-video').textContent = hidden ? '显示画面' : '隐藏画面'; const s = this.plugin.peers.get(String(id)); if (s) this.updatePeer(s); } }
    showUnlock() { this.$('#unlock').hidden = false; }
    async unlock() {
      let failed = false;
      await Promise.all([...this.tiles.values()].map(async t => {
        if (t.audio?.srcObject) try { await t.audio.play(); } catch (_) { failed = true; }
        if (t.video.srcObject) t.video.play().catch(() => {});
      }));
      this.$('#unlock').hidden = !failed;
    }
    devices(devices) {
      for (const [kind, id, selected] of [['audioinput', 'audio-device', this.plugin.local.audio.deviceId], ['videoinput', 'video-device', this.plugin.local.camera.deviceId]]) {
        const select = this.$('#' + id); select.replaceChildren(new Option('系统默认', ''));
        let n = 0;
        for (const d of devices.filter(d => d.kind === kind)) select.append(new Option(d.label || (kind === 'audioinput' ? '麦克风 ' : '摄像头 ') + (++n), d.deviceId));
        select.value = selected;
      }
    }
    notice(text, error = false) { this.$('#notice').textContent = text; this.$('#notice').classList.toggle('error', error); }
    save() {
      if (this.options.rememberPosition === false) return;
      try { localStorage.setItem('p2p-media-ui-v1', JSON.stringify(this.state)); } catch (_) {}
    }
    layout() {
      this.dock.classList.toggle('collapsed', this.state.collapsed);
      this.dock.style.width = this.state.collapsed ? '218px' : 'min(' + clamp(this.state.width, 240, 420) + 'px, calc(100vw - 16px))';
      this.dock.style.opacity = this.state.opacity;
      this.$('#opacity').value = this.state.opacity * 100; this.$('#width').value = this.state.width;
      this.$('#collapse').textContent = this.state.collapsed ? '＋' : '−';
      this.$('#collapse').setAttribute('aria-label', this.state.collapsed ? '展开通话窗口' : '折叠通话窗口');
      this.constrain();
    }
    constrain() {
      const vv = global.visualViewport, w = vv?.width || innerWidth, h = vv?.height || innerHeight;
      const x0 = vv?.offsetLeft || 0, y0 = vv?.offsetTop || 0;
      const r = this.dock.getBoundingClientRect();
      this.state.x = clamp(this.state.x, x0 + 8, Math.max(x0 + 8, x0 + w - Math.min(r.width || 318, w - 16) - 8));
      this.state.y = clamp(this.state.y, y0 + 8, Math.max(y0 + 8, y0 + h - Math.min(r.height || 50, h - 16) - 8));
      this.dock.style.transform = 'translate3d(' + this.state.x + 'px,' + this.state.y + 'px,0)';
    }
    setOpacity(n) { this.state.opacity = clamp(n, 0.2, 1); this.layout(); this.save(); }
    setPosition(p) { this.state.x = Number(p.x) || 8; this.state.y = Number(p.y) || 8; this.constrain(); this.save(); }
    resetPosition() { this.setPosition({x: innerWidth - 334, y: Math.min(142, innerHeight / 5)}); }
    collapse(flag) { this.state.collapsed = flag; this.layout(); this.save(); }
    raise() {
      if (this.usePopover) {
        try { if (this.host.matches(':popover-open')) this.host.hidePopover(); this.host.showPopover(); return; }
        catch (_) { this.usePopover = false; this.host.removeAttribute('popover'); }
      }
      const fs = document.fullscreenElement;
      // Canvas/video cannot render child DOM: leave their fullscreen before fallback.
      if (fs && /^(CANVAS|VIDEO|IFRAME)$/.test(fs.tagName)) {
        document.exitFullscreen?.().catch(() => {});
        this.notice('当前浏览器不支持顶层浮窗，已退出画布全屏以显示通话控件。');
      } else if (fs && this.host.parentElement !== fs) fs.append(this.host);
      else if (!fs && this.host.parentElement !== document.body) document.body.append(this.host);
    }
    show() { this.hidden = false; this.host.style.removeProperty('display'); this.raise(); this.constrain(); }
    hide() {
      this.hidden = true;
      if (this.usePopover) { try { this.host.hidePopover(); } catch (_) {} }
      this.host.style.setProperty('display', 'none', 'important');
    }
    destroy() {
      for (const id of [...this.tiles.keys()]) this.removePeer(id);
      for (const off of this.offs) off(); this.resizeObserver?.disconnect();
      this.host.remove();
    }
  }

  class P2PMediaPlugin extends Events {
    constructor(options = {}) {
      super();
      if (!options.adapter) throw new TypeError('HostAdapter is required');
      this.adapter = options.adapter; this.options = options;
      this.peers = new Map(); this.logs = []; this.destroyed = false; this.prepared = false;
      this.local = new LocalMediaManager(this, options); this.offs = [];
    }
    async prepare() {
      if (this.prepared || this.destroyed) return this;
      this.prepared = true;
      if (this.options.ui?.enabled !== false) this.ui = new FloatingMediaUI(this, this.options.ui);
      const sub = (name, fn) => {
        const off = this.adapter[name]?.(fn); if (typeof off === 'function') this.offs.push(off);
      };
      sub('onPeerConnected', id => this.attachPeer(id));
      sub('onPeerDisconnected', id => this.detachPeer(id));
      sub('onSignal', (id, message) => {
        const s = this.peers.get(String(id)) || this.attachPeer(id);
        if (s && message?.sessionId === s.token && message.payload && typeof message.payload === 'object')
          s.receive(message.payload).catch(e => s.report(e));
      });
      sub('onRoomLeft', () => this.leaveRoom());
      for (const id of this.adapter.getPeerIds()) this.attachPeer(id);
      this.statsTimer = setInterval(() => { for (const s of this.peers.values()) s.pollStats(); this.ui?.updateRoom(); }, 2000);
      this.deviceChange = () => this.refreshDevices();
      navigator.mediaDevices?.addEventListener('devicechange', this.deviceChange);
      this.pageHide = () => this.leaveRoom(); global.addEventListener('pagehide', this.pageHide);
      // Capture phase: the game never sees Alt+C, even when pointer-locked.
      this.shortcut = e => {
        if (e.code === 'KeyC' && e.altKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault(); e.stopImmediatePropagation();
          if (!e.repeat) { this.adapter.releaseInput?.(); this.showUI(); this.expandUI(); this.unlockAudio(); }
        }
      };
      global.addEventListener('keydown', this.shortcut, true);
      this.localChanged(); return this;
    }
    attachPeer(id) {
      id = String(id); const pc = this.adapter.getPeerConnection(id); if (!pc) return null;
      const info = this.adapter.getPeerInfo?.(id) || {sessionId: id, initiator: false, polite: true};
      let s = this.peers.get(id);
      if (s && (s.pc !== pc || s.token !== info.sessionId)) { this.detachPeer(id); s = null; }
      if (!s) {
        if (this.peers.size >= 3) { this.log('peer-limit', {peer: id}); return null; }
        s = new PeerMediaSession(this, id, pc, info); this.peers.set(id, s); s.attachLocal();
      }
      s.info = info; s.polite = !!info.polite;
      if (info.ready) s.activate();
      this.ui?.updatePeer(s); return s;
    }
    detachPeer(id) {
      const s = this.peers.get(String(id)); if (!s) return;
      this.peers.delete(String(id)); s.destroy();
    }
    replaceAll(kind, track) { return Promise.allSettled([...this.peers.values()].map(s => s.replace(kind, track))); }
    applyQualities() { return Promise.allSettled([...this.peers.values()].map(s => s.applyQuality())); }
    localChanged() {
      if (this.destroyed) return;
      this.ui?.updateLocal(); for (const s of this.peers.values()) s.sendState();
      this.emit('local-state', this.local.state());
    }
    log(event, detail) {
      this.logs.push({time: new Date().toISOString(), event, detail}); if (this.logs.length > 100) this.logs.shift();
    }
    notice(text) { this.log('notice', {text}); this.ui?.notice(text, true); this.emit('notice', text); }
    enableMicrophone() { this.unlockAudio(); return this.local.audio.enable(); }
    muteMicrophone() { this.local.audio.mute(); }
    unmuteMicrophone() { this.unlockAudio(); return this.local.audio.unmute(); }
    disableMicrophone() { return this.local.audio.disable(); }
    enableCamera() { this.unlockAudio(); return this.local.camera.enable(); }
    disableCamera() { return this.local.camera.disable(); }
    switchCamera(deviceId) { return this.local.camera.switchDevice(deviceId); }
    switchMicrophone(deviceId) { return this.local.audio.switchDevice(deviceId); }
    setVideoQuality(v) { return this.local.setQuality(v).catch(e => this.notice(errorText(e, '画质'))); }
    setVideoFocus(focus) { this.local.focus = {x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1)}; this.local.pipeline?.setFocus(this.local.focus); }
    setUIOpacity(n) { this.ui?.setOpacity(n); }
    setUIPosition(p) { this.ui?.setPosition(p); }
    resetUIPosition() { this.ui?.resetPosition(); }
    collapseUI() { this.ui?.collapse(true); }
    expandUI() { this.ui?.collapse(false); }
    hideUI() { this.ui?.hide(); }
    showUI() { this.ui?.show(); }
    setRemoteVolume(id, n) { this.ui?.setRemoteVolume(id, n); }
    muteRemoteAudio(id) { this.ui?.setRemoteMuted(id, true); }
    unmuteRemoteAudio(id) { this.ui?.setRemoteMuted(id, false); }
    hideRemoteVideo(id) { this.ui?.setRemoteHidden(id, true); }
    showRemoteVideo(id) { this.ui?.setRemoteHidden(id, false); }
    async refreshDevices() {
      if (this.destroyed || !navigator.mediaDevices?.enumerateDevices) return [];
      try { const devices = await navigator.mediaDevices.enumerateDevices(); this.ui?.devices(devices); return devices; }
      catch (e) { this.notice(errorText(e, '设备列表')); return []; }
    }
    async unlockAudio() {
      if (this.destroyed) return;
      try {
        if (!this.audioContext) {
          const AC = global.AudioContext || global.webkitAudioContext;
          if (AC) this.audioContext = new AC();
        }
        if (this.audioContext?.state === 'suspended') await this.audioContext.resume();
      } catch (_) {}
      await this.ui?.unlock();
    }
    watchMicrophone(track) {
      clearInterval(this.levelTimer); this.micSource?.disconnect(); this.micSource = null; this.analyser = null;
      if (!track || !this.audioContext || this.destroyed) return;
      try {
        this.micSource = this.audioContext.createMediaStreamSource(new MediaStream([track]));
        this.analyser = this.audioContext.createAnalyser(); this.analyser.fftSize = 256;
        this.micSource.connect(this.analyser); const data = new Uint8Array(256);
        this.levelTimer = setInterval(() => {
          this.analyser?.getByteTimeDomainData(data);
          const rms = Math.sqrt(data.reduce((n, x) => n + ((x - 128) / 128) ** 2, 0) / data.length);
          this.ui?.tiles.get('local')?.el.classList.toggle('speaking', this.local.audio.state === 'active' && rms > 0.02);
        }, 150);
      } catch (_) {}
    }
    leaveRoom() {
      this.local.destroy(); for (const id of [...this.peers.keys()]) this.detachPeer(id);
      this.ui?.notice('已离开房间，麦克风和摄像头已释放。再次入房需主动开启。');
      this.ui?.updateRoom();
    }
    diagnostics() {
      return {version: VERSION, secureContext: global.isSecureContext, prepared: this.prepared,
        local: this.local.state(), video: this.local.pipeline?.diagnostics() || {mode: 'off'},
        quality: {...this.local.config}, topology: {maxPeers: 3, attached: this.peers.size},
        peers: [...this.peers.values()].map(s => ({id: s.id, state: s.pc.connectionState,
          signaling: s.pc.signalingState, remote: {...s.remoteState}, stats: {...s.stats},
          transceivers: s.pc.getTransceivers().map(t => ({kind: t.receiver.track.kind, direction: t.direction, currentDirection: t.currentDirection})),
          sharedAudio: !!s.audioTransceiver?.sender.track && s.audioTransceiver.sender.track === this.local.audio.track,
          sharedVideo: !!s.videoTransceiver?.sender.track && s.videoTransceiver.sender.track === this.local.videoTrack,
          negotiation: {offers: s.negotiation.offers, answers: s.negotiation.answers, collisions: s.negotiation.collisions}})),
        logs: this.logs.slice()}; // No SDP, candidates, device IDs, room codes or TURN credentials.
    }
    exportDiagnostics() {
      const blob = new Blob([JSON.stringify(this.diagnostics(), null, 2)], {type: 'application/json'});
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'dust2-media-diagnostics.json';
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    destroy() {
      if (this.destroyed) return; this.leaveRoom(); this.destroyed = true;
      clearInterval(this.statsTimer); clearInterval(this.levelTimer);
      navigator.mediaDevices?.removeEventListener('devicechange', this.deviceChange);
      global.removeEventListener('pagehide', this.pageHide); global.removeEventListener('keydown', this.shortcut, true);
      for (const off of this.offs) off(); this.offs.length = 0;
      this.audioContext?.close().catch(() => {}); this.ui?.destroy(); this.ui = null; this.listeners.clear();
    }
  }
  global.P2PMediaPlugin = P2PMediaPlugin;
  // Reusable classes are also available for host-independent integration tests.
  global.P2PMediaPluginInternals = Object.freeze({SquareVideoPipeline, LocalMediaManager, DeviceController, NegotiationController, PeerMediaSession, PRESETS, VERSION});
})(window);
