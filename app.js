/* ================================================
   ZABISS EDITOR — app.js
   ================================================ */

'use strict';

// ─── HELPERS ─────────────────────────────────────
// Extrai mensagem legível de qualquer tipo de erro (Error, string, Event, etc.)
function errMsg(e) {
  if (!e) return 'Erro desconhecido';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.toString && e.toString() !== '[object Object]') return e.toString();
  return JSON.stringify(e);
}

// Copia texto para o clipboard com fallback (funciona em browser, Tauri e WebKit antigos)
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback: textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }
}

// ─── TAURI DETECTION ─────────────────────────────
// true quando rodando como app desktop (Tauri)
// false quando rodando no navegador (usa FFmpeg.wasm como fallback)
const IS_TAURI = typeof window !== 'undefined' && !!window.__TAURI__;

// ID da sessão atual de processamento (Tauri cria pasta temp por sessão)
let tauriSession = null;

// Wrapper para chamar comandos Rust via IPC do Tauri
function tauriInvoke(cmd, args = {}) {
  return window.__TAURI__.core.invoke(cmd, args);
}

// Converte caminho do disco em URL acessível pelo webview do Tauri
function tauriSrc(path) {
  return window.__TAURI__.core.convertFileSrc(path);
}

// Obtém caminho temporário para um arquivo dentro da sessão atual
async function tauriTempPath(filename) {
  return tauriInvoke('get_temp_path', { sessionId: tauriSession, filename });
}

// ─── CONFIG ──────────────────────────────────────
const CFG = {
  FFMPEG_CORE:      'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js',
  GROQ_BASE:        'https://api.groq.com/openai/v1',
  GROQ_VISION:      'meta-llama/llama-4-scout-17b-16e-instruct',
  GROQ_WHISPER:     'whisper-large-v3-turbo',
  GROQ_TEXT:        'llama-3.3-70b-versatile',
  SEG_DEFAULT:      8,
  PROMPT_BATCH_SIZE: 5,   // max images por chamada Groq Vision
  TEXT_BATCH_SIZE:   15,  // transcrições por chamada de texto
};

const LIMITS = {
  cut:            7200, // 2h
  ai:             3000, // 50min
  video_combined: 3600, // 1h — o que importa é o tamanho do arquivo, não a duração
  audio_combined: 3600, // 1h
};

// Limite de tamanho de arquivo por modo (bytes)
// O WASM precisa carregar o arquivo inteiro na memória — arquivo grande é o verdadeiro gargalo
const FILE_SIZE_LIMITS = {
  warn:  400 * 1024 * 1024,  // 400MB — avisa
  block: 1300 * 1024 * 1024, // 1.3GB — bloqueia (WASM não aguenta mais que isso com folga)
};

const FFMPEG_OP_TIMEOUT = 150_000; // 2,5min por operação FFmpeg antes de declarar hang

// ─── STATE ───────────────────────────────────────
let ST = {
  mode:         null,
  inputType:    'video',   // 'video' | 'audio'
  inputExt:     'mp4',
  mediaFile:    null,      // File object (modo browser)
  inputPath:    null,      // caminho em disco (modo Tauri)
  inputSize:    0,         // tamanho em bytes (ambos os modos)
  apiKey:       localStorage.getItem('zabiss_groq_key') || '',
  segDur:       CFG.SEG_DEFAULT,
  lang:         'pt',
  promptLevel:    3,
  customPrompt:   '',
  saveTxtFiles:   false, // checkbox: salvar prompts/combined como .txt além do painel
  outputFiles:     [],   // arquivos para baixar (zip/pasta)
  generatedTexts:  [],   // [{idx, name, text}] para exibir no painel (independente de salvar)
  generatedImages: [],   // [{idx, name, blob, ok}] imagens geradas via Pollinations
  totalSegs:      0,
  doneSegs:       0,
};

// Push helper: adiciona texto ao painel SEMPRE e ao outputFiles condicionalmente
function pushTextOutput(idx, text, mustSave) {
  ST.generatedTexts.push({ idx, name: `Parte ${idx}`, text });
  if (mustSave) {
    ST.outputFiles.push({
      name: `Parte ${idx}.txt`,
      blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
      type: 'text',
    });
  }
}

// Decide se este modo deve salvar .txt no disco
function shouldSaveTxt() {
  if (ST.mode === 'transcribe') return true;             // transcrição sempre salva
  if (ST.mode === 'prompts' || ST.mode === 'combined') return ST.saveTxtFiles;
  return false;
}

// ─── PROMPT LEVELS ───────────────────────────────
const PROMPT_LEVELS = {
  1: {
    label: 'Descreve fielmente a cena — quase uma legenda detalhada. Ideal para recriar exatamente o que está acontecendo.',
    system: `Você gera prompts para IA de imagens. Analise o conteúdo e descreva objetivamente a cena: personagens, ambiente, ações, expressões, iluminação. Seja fiel ao que está presente. Use 2-3 frases diretas e concretas, sem metáforas. O resultado deve permitir recriar a cena com precisão.`,
  },
  2: {
    label: 'Levemente enriquecido — mantém o conteúdo original com pequenos detalhes visuais e emocionais adicionados.',
    system: `Você gera prompts para IA de imagens. Descreva o conteúdo de forma clara e ligeiramente enriquecida: mencione o que está acontecendo, acrescente detalhes visuais sutis (cores, atmosfera, expressão) que complementem sem alterar o conteúdo. 2-3 frases. Mantenha alta fidelidade ao original.`,
  },
  3: {
    label: 'Equilibrado entre fidelidade e criatividade — mantém o tema central com linguagem narrativa e metáforas moderadas.',
    system: `Você gera prompts narrativos para IA de imagens. Para cada parte, crie uma descrição que equilibre fidelidade ao conteúdo original com interpretação criativa. Adicione contexto emocional, metáforas moderadas e linguagem expressiva sem distorcer o tema central. 2-3 frases envolventes.`,
  },
  4: {
    label: 'Criativo e poético — usa o conteúdo como inspiração para narrativas ricas em metáforas e imagens vívidas.',
    system: `Você é um escritor criativo que gera prompts para IA de imagens. Use cada parte como ponto de partida para criar narrativas poéticas e ricas em metáforas. Mantenha o tema mas transforme com imagens vívidas, simbolismo e linguagem expressiva. 2-3 frases com forte apelo visual e emocional.`,
  },
  5: {
    label: 'Reinvenção livre — máxima criatividade, transforma completamente o conteúdo em narrativa literária e cinematográfica.',
    system: `Você é um contador de histórias cinematográfico. Com base no conteúdo fornecido, escreva narrativas que reinventam livremente com máxima criatividade poética. Transforme o original em algo literário, evocativo e visualmente impactante. Use linguagem rica, metáforas ousadas e construa uma história envolvente. 2-3 frases por parte.`,
  },
};

const MODE_DESCRIPTIONS = {
  video: {
    cut:       { icon: '✂️', name: 'Corte de Vídeo',      desc: 'Divide seu vídeo em partes de Ns.\nExporta <strong>Parte 1.mp4</strong>, <strong>Parte 2.mp4</strong>…\nNão requer API.', badge: 'badge-free', badgeText: 'Grátis' },
    transcribe:{ icon: '🎙️', name: 'Texto do Vídeo',      desc: 'Transcreve o áudio a cada Ns.\nExporta <strong>Parte 1.txt</strong>…\nUsa Groq Whisper.', badge: 'badge-ai', badgeText: 'IA · Whisper' },
    prompts:   { icon: '✨', name: 'Gerador de Prompts',  desc: 'Analisa frames visuais a cada Ns\ne gera narrativa com contexto acumulado.\nUsa Groq Vision.', badge: 'badge-ai', badgeText: 'IA · Vision' },
    combined:  { icon: '⚡', name: 'Modo Conjunto',       desc: 'Corta o vídeo <em>e</em> gera prompts visuais.\nExporta <strong>Parte N.mp4</strong> + <strong>Parte N.txt</strong>.', badge: 'badge-combo', badgeText: 'Completo' },
  },
  audio: {
    cut:       { icon: '✂️', name: 'Corte de Áudio',      desc: 'Divide seu áudio em partes de Ns.\nExporta <strong>Parte 1.mp3</strong>, <strong>Parte 2.mp3</strong>…\nNão requer API.', badge: 'badge-free', badgeText: 'Grátis' },
    transcribe:{ icon: '🎙️', name: 'Texto do Áudio',      desc: 'Transcreve o áudio a cada Ns.\nExporta <strong>Parte 1.txt</strong>…\nUsa Groq Whisper.', badge: 'badge-ai', badgeText: 'IA · Whisper' },
    prompts:   { icon: '✨', name: 'Gerador de Prompts',  desc: 'Transcreve o áudio e gera prompts\nnarrativas de cada parte.\nUsa Whisper + Llama.', badge: 'badge-ai', badgeText: 'IA · Texto' },
    combined:  { icon: '⚡', name: 'Modo Conjunto',       desc: 'Corta o áudio <em>e</em> gera prompts\na partir da transcrição.\nExporta <strong>Parte N.mp3</strong> + <strong>Parte N.txt</strong>.', badge: 'badge-combo', badgeText: 'Completo' },
  },
};

let ffmpegInst = null;
let ffmpegReady = false;

// ─── DOM ─────────────────────────────────────────
const $   = id  => document.getElementById(id);
const $$  = sel => document.querySelector(sel);
const $$$ = sel => document.querySelectorAll(sel);

// ─── FFmpeg INIT ─────────────────────────────────
async function loadFFmpeg() {
  const loader    = $('ffmpeg-loader');
  const loaderBar = $('loader-bar-fill');
  const loaderSub = $('loader-sub');

  // Modo Tauri: usa FFmpeg nativo do sistema, WASM não é necessário
  if (IS_TAURI) {
    ffmpegReady = true;
    loader.classList.add('hidden');
    addLog('Modo desktop — FFmpeg nativo ativo ✓', 'success');
    return;
  }

  loader.classList.remove('hidden');
  loaderSub.textContent = 'Carregando FFmpeg (~30MB na primeira vez)…';
  loaderBar.style.width = '5%';

  try {
    const { createFFmpeg } = FFmpeg;
    ffmpegInst = createFFmpeg({
      log: false,
      corePath: CFG.FFMPEG_CORE,
      logger: ({ type, message }) => {
        if (!message) return;
        if (message.startsWith('Parsed_') || message.startsWith('Stream mapping')) return;
        if (type === 'fferr') addLog(message, 'info');
      },
      progress: ({ ratio }) => {
        loaderBar.style.width = Math.round(10 + ratio * 85) + '%';
        if (ST.totalSegs > 0) {
          const pct = ((ST.doneSegs + ratio) / ST.totalSegs) * 100;
          setProgress(pct, `Processando parte ${ST.doneSegs + 1} de ${ST.totalSegs}…`);
        }
      },
    });

    loaderSub.textContent = 'Baixando ffmpeg-core (~30MB)…';
    await ffmpegInst.load();
    loaderBar.style.width = '100%';
    ffmpegReady = true;
    setTimeout(() => loader.classList.add('hidden'), 400);
    addLog('FFmpeg.wasm carregado ✓', 'success');
  } catch (err) {
    loader.classList.add('hidden');
    showToast('Falha ao carregar FFmpeg: ' + errMsg(err), 'error');
    console.error(err);
  }
}

// ─── MEDIA UTILS ─────────────────────────────────
function getInputExtension(file) {
  const map = {
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/wav': 'wav',  'audio/wave': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',  'audio/aac': 'aac',
    'audio/m4a': 'm4a',  'audio/x-m4a': 'm4a', 'audio/mp4': 'm4a',
    'audio/flac': 'flac',
    'video/mp4': 'mp4',  'video/webm': 'webm',
    'video/quicktime': 'mov', 'video/avi': 'avi', 'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
  };
  return map[file.type] || file.name.split('.').pop().toLowerCase() || 'mp4';
}

async function getMediaDuration(file) {
  // Tauri: usa FFmpeg via Rust (não depende do webview ler o arquivo)
  if (IS_TAURI) {
    return tauriInvoke('get_media_duration', { path: ST.inputPath });
  }
  // Browser: usa elemento HTML
  return new Promise((resolve, reject) => {
    const el = ST.inputType === 'audio' ? new Audio() : document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => { URL.revokeObjectURL(el.src); resolve(el.duration); };
    el.onerror = () => reject(new Error('Não foi possível ler o arquivo de mídia. Verifique se o formato é suportado.'));
    el.src = URL.createObjectURL(file);
  });
}

function getDurationLimit() {
  if (ST.mode === 'cut') return LIMITS.cut;
  if (ST.mode === 'combined') return ST.inputType === 'audio' ? LIMITS.audio_combined : LIMITS.video_combined;
  return LIMITS.ai;
}

function getLimitLabel() {
  const sec = getDurationLimit();
  return fmtTime(sec);
}

// Executa FFmpeg: nativo (Tauri) ou WASM (browser) com timeout de segurança
async function ffmpegRun(...args) {
  if (IS_TAURI) {
    // Sem timeout aqui — FFmpeg nativo não trava por falta de RAM
    return tauriInvoke('ffmpeg_exec', { args });
  }
  return Promise.race([
    ffmpegInst.run(...args),
    new Promise((_, reject) =>
      setTimeout(() =>
        reject(new Error(
          `Operação FFmpeg travou (>${FFMPEG_OP_TIMEOUT / 60000} min). ` +
          `O arquivo pode ser grande demais. Tente um arquivo menor ou use o modo "Só Corte".`
        )), FFMPEG_OP_TIMEOUT)
    ),
  ]);
}

async function writeInputToFFmpeg(file) {
  if (IS_TAURI) {
    // Tauri: FFmpeg lê direto do disco, não precisa copiar nada
    addLog(`Arquivo: ${ST.inputPath} (${fmtSize(ST.inputSize)})`, 'info');
    return;
  }
  const { fetchFile } = FFmpeg;
  addLog(`Carregando mídia no processador (${fmtSize(file.size)})…`, 'info');
  const data = await fetchFile(file);
  ffmpegInst.FS('writeFile', `input.${ST.inputExt}`, data);
}

function unlinkInput() {
  if (IS_TAURI) return; // Não apaga o arquivo original do usuário
  try { ffmpegInst.FS('unlink', `input.${ST.inputExt}`); } catch (_) {}
}

async function cutSegment(start, end, idx) {
  const isAudio = ST.inputType === 'audio';
  const outExt  = isAudio ? 'mp3' : 'mp4';
  const encArgs = isAudio
    ? ['-acodec', 'libmp3lame', '-q:a', '4']
    : ['-c', 'copy', '-avoid_negative_ts', 'make_zero'];

  if (IS_TAURI) {
    // Tauri: lê do disco, escreve em temp, retorna como Blob
    const outPath = await tauriTempPath(`out_${idx}.${outExt}`);
    await ffmpegRun('-i', ST.inputPath, '-ss', String(start), '-to', String(end), ...encArgs, '-y', outPath);
    const bytes = await tauriInvoke('read_file_bytes', { path: outPath });
    await tauriInvoke('delete_file', { path: outPath });
    return new Blob([new Uint8Array(bytes)], { type: isAudio ? 'audio/mpeg' : 'video/mp4' });
  }

  // WASM: usa filesystem virtual do WASM
  const outName = `out_${idx}.${outExt}`;
  await ffmpegRun('-i', `input.${ST.inputExt}`, '-ss', String(start), '-to', String(end), ...encArgs, outName);
  const data = ffmpegInst.FS('readFile', outName);
  ffmpegInst.FS('unlink', outName);
  return new Blob([data.buffer], { type: isAudio ? 'audio/mpeg' : 'video/mp4' });
}

async function extractAudioSegment(start, end, idx) {
  const wavArgs = ['-ss', String(start), '-to', String(end), '-ar', '16000', '-ac', '1', '-f', 'wav'];
  if (ST.inputType === 'video') wavArgs.push('-vn');

  if (IS_TAURI) {
    const outPath = await tauriTempPath(`audio_${idx}.wav`);
    await ffmpegRun('-i', ST.inputPath, ...wavArgs, '-y', outPath);
    const bytes = await tauriInvoke('read_file_bytes', { path: outPath });
    await tauriInvoke('delete_file', { path: outPath });
    return new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
  }

  const outName = `audio_${idx}.wav`;
  await ffmpegRun('-i', `input.${ST.inputExt}`, ...wavArgs, outName);
  const data = ffmpegInst.FS('readFile', outName);
  ffmpegInst.FS('unlink', outName);
  return new Blob([data.buffer], { type: 'audio/wav' });
}

// Extrai o áudio INTEIRO do arquivo como MP3 mono comprimido para Whisper.
// 48kbps mono caem ~70min num arquivo de 25MB (limite do Groq Whisper).
async function extractFullAudio() {
  const audioArgs = ['-vn', '-c:a', 'libmp3lame', '-b:a', '48k', '-ac', '1', '-ar', '16000'];

  if (IS_TAURI) {
    const outPath = await tauriTempPath('full_audio.mp3');
    await ffmpegRun('-i', ST.inputPath, ...audioArgs, '-y', outPath);
    const bytes = await tauriInvoke('read_file_bytes', { path: outPath });
    await tauriInvoke('delete_file', { path: outPath });
    return new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' });
  }

  const outName = 'full_audio.mp3';
  await ffmpegRun('-i', `input.${ST.inputExt}`, ...audioArgs, outName);
  const data = ffmpegInst.FS('readFile', outName);
  ffmpegInst.FS('unlink', outName);
  return new Blob([data.buffer], { type: 'audio/mpeg' });
}

async function extractFrameAtTime(file, timeSec) {
  // Tauri: usa FFmpeg via Rust para extrair o frame como JPEG base64
  if (IS_TAURI) {
    return tauriInvoke('extract_frame_at', {
      sessionId: tauriSession || 'thumb',
      path:      ST.inputPath,
      timeSec,
    });
  }
  // Browser: usa Canvas + HTMLVideoElement
  return new Promise((resolve, reject) => {
    const video  = document.createElement('video');
    const canvas = document.createElement('canvas');
    let resolved = false;

    video.onloadedmetadata = () => {
      canvas.width  = Math.min(video.videoWidth, 1280);
      canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
      video.currentTime = Math.max(0, Math.min(timeSec, video.duration - 0.1));
    };
    video.onseeked = () => {
      if (resolved) return;
      resolved = true;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(video.src);
      resolve(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    video.onerror = () => {
      if (!resolved) { resolved = true; reject(new Error('Erro ao carregar frame do vídeo.')); }
    };
    setTimeout(() => {
      if (!resolved) { resolved = true; URL.revokeObjectURL(video.src); reject(new Error('Frame extraction timeout')); }
    }, 12000);
    video.src = URL.createObjectURL(file);
  });
}

// ─── GROQ API ────────────────────────────────────

// Groq Whisper free tier: ~20 req/min → janela de 60s
// Groq Vision/Text free tier: ~30k TPM → espera sugerida pelo header
const WHISPER_MIN_WAIT = 65; // segundos — garante reset da janela de 1 minuto

function parseRetryAfter(errText) {
  const m = errText.match(/try again in ([\d.]+)s/i);
  return m ? Math.ceil(parseFloat(m[1])) + 1 : 20;
}

async function groqFetch(fetchFn, label, maxRetries = 8) {
  const isWhisper = label.includes('Whisper');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetchFn();
    if (res.ok) return res;
    const body = await res.text();

    if (res.status === 429) {
      // Whisper: usa sempre o mínimo de 65s para garantir reset da janela/minuto
      // Vision/Text: usa o tempo sugerido pela API
      const suggested = parseRetryAfter(body);
      const waitSec   = isWhisper ? Math.max(suggested, WHISPER_MIN_WAIT) : suggested;

      addLog(`  ⏳ Rate limit (${label}) — aguardando ${waitSec}s para resetar janela… (${attempt}/${maxRetries})`, 'warn');

      // Countdown em blocos de 10s
      let remaining = waitSec;
      while (remaining > 0) {
        const chunk = Math.min(10, remaining);
        await sleep(chunk * 1000);
        remaining -= chunk;
        if (remaining > 0) addLog(`  … ${remaining}s restantes`, 'warn');
      }

      addLog(`  ↩ Tentando novamente (${attempt}/${maxRetries})…`, 'info');
      continue;
    }

    throw new Error(`${label} (${res.status}): ${body}`);
  }
  throw new Error(`${label}: limite de tentativas atingido após ${maxRetries} tentativas.`);
}

// Limite do Groq Whisper: 25MB por arquivo
const WHISPER_MAX_BYTES = 24 * 1024 * 1024; // 24MB margem de segurança

// Envia o áudio inteiro para Whisper e retorna { segments: [{start, end, text}], text }
async function groqTranscribeFull(audioBlob) {
  const fd = new FormData();
  fd.append('file', audioBlob, 'audio.mp3');
  fd.append('model', CFG.GROQ_WHISPER);
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'segment');
  if (ST.lang !== 'auto') fd.append('language', ST.lang);

  const res = await groqFetch(() => fetch(`${CFG.GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ST.apiKey}` },
    body: fd,
  }), 'Groq Whisper');
  return await res.json();
}

// Distribui o texto transcrito pelas partes do usuário usando os timestamps
function splitTranscriptionByTime(whisperResult, userSegs) {
  const wsegs = whisperResult.segments || [];
  const buckets = userSegs.map(s => ({ idx: s.idx, start: s.start, end: s.end, parts: [] }));

  for (const ws of wsegs) {
    // Pelo ponto médio do segmento Whisper, decide em qual parte do usuário ele cai
    const mid = ((ws.start ?? 0) + (ws.end ?? 0)) / 2;
    const bucket = buckets.find(b => mid >= b.start && mid < b.end) || buckets[buckets.length - 1];
    if (bucket && ws.text) bucket.parts.push(ws.text.trim());
  }

  return buckets.map(b => b.parts.join(' ').trim());
}

// Caminho rápido: extrai áudio inteiro, manda 1x para Whisper, divide pelos timestamps
// Retorna array de { idx, text } na mesma ordem dos segs
async function transcribeAllFast(segs) {
  setProgress(8, 'Extraindo áudio do arquivo…');
  const audio = await extractFullAudio();
  addLog(`Áudio extraído: ${fmtSize(audio.size)}`, 'info');

  if (audio.size > WHISPER_MAX_BYTES) {
    addLog(`Arquivo muito grande para envio único (${fmtSize(audio.size)}) — usando modo lento por segmento.`, 'warn');
    return null; // sinaliza fallback
  }

  setProgress(20, 'Enviando para Groq Whisper (1 chamada)…');
  const result = await groqTranscribeFull(audio);
  setProgress(75, 'Distribuindo texto pelas partes…');

  const texts = splitTranscriptionByTime(result, segs);
  return segs.map((s, i) => ({ idx: s.idx, text: texts[i] || '[sem fala]' }));
}

async function groqTranscribe(audioBlob) {
  const fd = new FormData();
  fd.append('file', audioBlob, 'audio.wav');
  fd.append('model', CFG.GROQ_WHISPER);
  fd.append('response_format', 'json');
  if (ST.lang !== 'auto') fd.append('language', ST.lang);

  const res  = await groqFetch(() => fetch(`${CFG.GROQ_BASE}/audio/transcriptions`, {
    method: 'POST', headers: { Authorization: `Bearer ${ST.apiKey}` }, body: fd,
  }), 'Groq Whisper');
  const json = await res.json();
  return (json.text || '').trim();
}

// Batch visual: N frames → 1 chamada (vídeo)
async function groqVisionPromptsAll(frames, prevCtxText) {
  const systemText = ST.customPrompt.trim() || (PROMPT_LEVELS[ST.promptLevel] || PROMPT_LEVELS[3]).system;
  const content    = [];

  if (prevCtxText) content.push({ type: 'text', text: `Contexto anterior:\n${prevCtxText}\n\n---` });

  for (const { idx, base64 } of frames) {
    content.push({ type: 'text',      text: `[Parte ${idx}]` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } });
  }

  const first = frames[0].idx, last = frames[frames.length - 1].idx;
  content.push({ type: 'text', text:
    `${systemText}\n\nAnalise os ${frames.length} frames (Partes ${first}–${last}) em ordem.\n\n` +
    `Responda APENAS com JSON:\n{"partes":["prompt da parte ${first}",...,"prompt da parte ${last}"]}\n` +
    `O array deve ter exatamente ${frames.length} strings.`
  });

  const res  = await groqFetch(() => fetch(`${CFG.GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ST.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.GROQ_VISION,
      messages: [{ role: 'user', content }],
      max_tokens: frames.length * 320 + 80,
      temperature: [0, 0.35, 0.35, 0.6, 0.78, 0.9][ST.promptLevel] ?? 0.6,
    }),
  }), 'Groq Vision Batch');
  const json = await res.json();
  return extractPromptsFromText((json.choices?.[0]?.message?.content || '').trim(), frames.length);
}

// Batch textual: N transcrições → 1 chamada (áudio)
async function groqTextPromptsAll(transcriptions, prevCtxText) {
  const systemText = ST.customPrompt.trim() || (PROMPT_LEVELS[ST.promptLevel] || PROMPT_LEVELS[3]).system;
  const first = transcriptions[0].idx, last = transcriptions[transcriptions.length - 1].idx;

  const transcript = transcriptions.map(t => `[Parte ${t.idx}]: "${t.text}"`).join('\n');
  const ctxBlock   = prevCtxText ? `Contexto anterior:\n${prevCtxText}\n\n---\n\n` : '';

  const userMsg =
    `${ctxBlock}Aqui estão as transcrições do áudio em ${transcriptions.length} partes:\n\n${transcript}\n\n` +
    `Gere um prompt de imagem para cada parte seguindo as instruções do sistema.\n\n` +
    `Responda APENAS com JSON:\n{"partes":["prompt da parte ${first}",...,"prompt da parte ${last}"]}\n` +
    `O array deve ter exatamente ${transcriptions.length} strings.`;

  const res  = await groqFetch(() => fetch(`${CFG.GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ST.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.GROQ_TEXT,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user',   content: userMsg },
      ],
      max_tokens: transcriptions.length * 280 + 80,
      temperature: [0, 0.35, 0.35, 0.6, 0.78, 0.9][ST.promptLevel] ?? 0.6,
    }),
  }), 'Groq Text Batch');
  const json = await res.json();
  return extractPromptsFromText((json.choices?.[0]?.message?.content || '').trim(), transcriptions.length);
}

function extractPromptsFromText(text, expectedCount) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      const arr = obj.partes ?? obj.prompts ?? obj.narrativas ?? obj.parts ?? Object.values(obj).find(Array.isArray);
      if (Array.isArray(arr) && arr.length >= 1) return padArray(arr.map(String), expectedCount);
    }
  } catch (_) {}
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr) && arr.length >= 1) return padArray(arr.map(String), expectedCount);
    }
  } catch (_) {}
  const numbered = text
    .split(/\n(?=\s*(?:\[Parte\s+\d+\]|\d+[\.\)])\s)/i)
    .map(s => s.replace(/^\s*(?:\[Parte\s+\d+\]\s*|"\s*|'?\s*|\d+[\.\)]\s*)/, '').replace(/[",\s]+$/, '').trim())
    .filter(s => s.length > 10);
  if (numbered.length >= expectedCount) return numbered.slice(0, expectedCount);
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 10);
  if (paras.length >= expectedCount) return paras.slice(0, expectedCount);
  const chunk = Math.max(1, Math.floor(text.length / expectedCount));
  return Array.from({ length: expectedCount }, (_, i) => text.slice(i * chunk, (i + 1) * chunk).trim() || '—');
}

function padArray(arr, n) {
  while (arr.length < n) arr.push(arr[arr.length - 1] || '—');
  return arr.slice(0, n);
}

// ─── PROCESSING MODES ────────────────────────────
function calcSegments(duration, segDur) {
  const segs = [];
  const count = Math.ceil(duration / segDur);
  for (let i = 0; i < count; i++) segs.push({
    idx: i + 1, start: i * segDur, end: Math.min((i + 1) * segDur, duration),
  });
  return segs;
}

async function runCutMode(segs) {
  addLog(`Cortando ${ST.inputType} em ${segs.length} partes de ${ST.segDur}s…`, 'info');
  await writeInputToFFmpeg(ST.mediaFile);
  const ext = ST.inputType === 'audio' ? 'mp3' : 'mp4';

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    setSegActive(seg.idx);
    setProgress((i / segs.length) * 98, `Cortando Parte ${seg.idx}/${segs.length}…`);
    addLog(`↳ Parte ${seg.idx}: ${fmtTime(seg.start)} → ${fmtTime(seg.end)}`, 'info');
    const blob = await cutSegment(seg.start, seg.end, seg.idx);
    ST.outputFiles.push({ name: `Parte ${seg.idx}.${ext}`, blob, type: ST.inputType });
    ST.doneSegs++;
    setSegDone(seg.idx);
    addLog(`  ✓ Parte ${seg.idx}.${ext} (${fmtSize(blob.size)})`, 'success');
  }
  unlinkInput();
}

async function runTranscribeMode(segs) {
  requireApiKey();
  await writeInputToFFmpeg(ST.mediaFile);

  // Caminho rápido: 1 chamada para todo o áudio + divisão por timestamps
  addLog(`Transcrevendo ${segs.length} partes (modo rápido — 1 chamada Whisper)…`, 'info');
  let results = null;
  try {
    results = await transcribeAllFast(segs);
  } catch (err) {
    addLog('Modo rápido falhou: ' + errMsg(err) + ' — usando modo lento.', 'warn');
  }

  if (results) {
    setProgress(90, 'Salvando arquivos…');
    const save = shouldSaveTxt();
    for (let i = 0; i < segs.length; i++) {
      const r = results[i];
      const txt = r.text || '[Nenhuma fala detectada]';
      setSegActive(r.idx);
      pushTextOutput(r.idx, txt, save);
      ST.doneSegs++;
      setSegDone(r.idx);
      addLog(`  ✓ Parte ${r.idx} — "${txt.slice(0, 55)}…"`, 'success');
    }
    unlinkInput();
    return;
  }

  // Fallback: método antigo (1 chamada por segmento)
  addLog(`Modo lento: ${segs.length} chamadas separadas…`, 'info');
  const save = shouldSaveTxt();
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    setSegActive(seg.idx);
    setProgress((i / segs.length) * 97, `Parte ${seg.idx}/${segs.length}…`);
    const audioBlob = await extractAudioSegment(seg.start, seg.end, seg.idx);
    const text    = await groqTranscribe(audioBlob);
    const content = text || '[Nenhuma fala detectada]';
    pushTextOutput(seg.idx, content, save);
    ST.doneSegs++;
    setSegDone(seg.idx);
    addLog(`  ✓ Parte ${seg.idx} — "${content.slice(0, 55)}…"`, 'success');
    if (i < segs.length - 1) await sleep(3500);
  }
  unlinkInput();
}

async function runVideoPromptsMode(segs) {
  requireApiKey();
  const total = segs.length;
  const modeLabel = ST.customPrompt.trim() ? 'Prompt personalizado' : `Nível ${ST.promptLevel}`;
  addLog(`Prompts visuais (${modeLabel}) — ${Math.ceil(total / CFG.PROMPT_BATCH_SIZE)} chamada(s)…`, 'info');

  // Fase 1 — extrair frames
  const frames = [];
  for (let i = 0; i < total; i++) {
    const seg = segs[i];
    setSegActive(seg.idx);
    setProgress((i / total) * 48, `Extraindo frame ${i + 1}/${total}…`);
    const mid = seg.start + (seg.end - seg.start) / 2;
    frames.push({ idx: seg.idx, base64: await extractFrameAtTime(ST.mediaFile, mid) });
    setSegDone(seg.idx);
  }

  // Fase 2 — batch Vision
  renderSegDots(total);
  const batches = [];
  for (let i = 0; i < frames.length; i += CFG.PROMPT_BATCH_SIZE) batches.push(frames.slice(i, i + CFG.PROMPT_BATCH_SIZE));

  const allPrompts = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    setProgress(50 + (b / batches.length) * 42, `Lote ${b + 1}/${batches.length} → Groq Vision…`);
    addLog(`↳ Lote ${b + 1}/${batches.length}: ${batch.length} frames em 1 chamada…`, 'info');
    batch.forEach(f => setSegActive(f.idx));
    const prevCtx = allPrompts.length ? allPrompts.slice(-3).map((p, i) => `[Parte ${allPrompts.length - 2 + i}] ${p}`).join('\n') : null;
    const prompts = await groqVisionPromptsAll(batch, prevCtx);
    allPrompts.push(...prompts);
    batch.forEach(f => setSegDone(f.idx));
    if (b < batches.length - 1) await sleep(1500);
  }

  setProgress(94, 'Salvando arquivos…');
  const save = shouldSaveTxt();
  for (let i = 0; i < total; i++) {
    const prompt = allPrompts[i] || '—';
    pushTextOutput(segs[i].idx, prompt, save);
    ST.doneSegs++;
    addLog(`  ✓ Parte ${segs[i].idx} — "${prompt.slice(0, 70)}…"`, 'success');
  }
}

async function runAudioPromptsMode(segs) {
  requireApiKey();
  const total = segs.length;
  const modeLabel = ST.customPrompt.trim() ? 'Prompt personalizado' : `Nível ${ST.promptLevel}`;
  addLog(`Prompts de áudio (${modeLabel}) — Whisper + Llama…`, 'info');
  await writeInputToFFmpeg(ST.mediaFile);

  // Fase 1 — transcrever (modo rápido: 1 chamada para tudo, com fallback)
  let transcriptions = null;
  try {
    addLog(`Transcrevendo ${total} partes (modo rápido — 1 chamada)…`, 'info');
    transcriptions = await transcribeAllFast(segs);
  } catch (err) {
    addLog('Modo rápido falhou: ' + errMsg(err) + ' — usando modo lento.', 'warn');
  }

  if (!transcriptions) {
    transcriptions = [];
    addLog(`Modo lento: ${total} chamadas Whisper…`, 'info');
    for (let i = 0; i < total; i++) {
      const seg = segs[i];
      setSegActive(seg.idx);
      setProgress((i / total) * 52, `Transcrevendo ${i + 1}/${total}…`);
      const audioBlob = await extractAudioSegment(seg.start, seg.end, seg.idx);
      const text      = await groqTranscribe(audioBlob);
      transcriptions.push({ idx: seg.idx, text: text || '[sem fala]' });
      setSegDone(seg.idx);
      if (i < total - 1) await sleep(3500);
    }
  } else {
    transcriptions.forEach(t => setSegDone(t.idx));
  }
  unlinkInput();

  // Fase 2 — gerar prompts em batch (texto)
  renderSegDots(total);
  const batches = [];
  for (let i = 0; i < transcriptions.length; i += CFG.TEXT_BATCH_SIZE) batches.push(transcriptions.slice(i, i + CFG.TEXT_BATCH_SIZE));

  const allPrompts = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    setProgress(55 + (b / batches.length) * 37, `Gerando prompts lote ${b + 1}/${batches.length}…`);
    addLog(`↳ Lote ${b + 1}/${batches.length}: ${batch.length} partes → Groq Text…`, 'info');
    batch.forEach(t => setSegActive(t.idx));
    const prevCtx = allPrompts.length ? allPrompts.slice(-3).join('\n') : null;
    const prompts = await groqTextPromptsAll(batch, prevCtx);
    allPrompts.push(...prompts);
    batch.forEach(t => setSegDone(t.idx));
    if (b < batches.length - 1) await sleep(1500);
  }

  setProgress(94, 'Salvando arquivos…');
  const save = shouldSaveTxt();
  for (let i = 0; i < total; i++) {
    const prompt = allPrompts[i] || '—';
    pushTextOutput(segs[i].idx, prompt, save);
    ST.doneSegs++;
    addLog(`  ✓ Parte ${segs[i].idx} — "${prompt.slice(0, 70)}…"`, 'success');
  }
}

async function runVideoCombinedMode(segs) {
  requireApiKey();
  const total = segs.length;
  addLog(`Modo Conjunto (vídeo) — ${total} partes…`, 'info');
  await writeInputToFFmpeg(ST.mediaFile);

  // Fase 1 — cortar vídeos
  for (let i = 0; i < total; i++) {
    const seg = segs[i];
    setSegActive(seg.idx);
    setProgress((i / total) * 38, `Cortando Parte ${seg.idx}/${total}…`);
    const blob = await cutSegment(seg.start, seg.end, seg.idx);
    ST.outputFiles.push({ name: `Parte ${seg.idx}.mp4`, blob, type: 'video' });
    ST.doneSegs++;
    setSegDone(seg.idx);
    addLog(`✓ Parte ${seg.idx}.mp4 (${fmtSize(blob.size)})`, 'success');
  }
  unlinkInput();

  // Fase 2 — extrair frames
  renderSegDots(total);
  const frames = [];
  for (let i = 0; i < total; i++) {
    const seg = segs[i];
    setSegActive(seg.idx);
    setProgress(40 + (i / total) * 22, `Extraindo frame ${i + 1}/${total}…`);
    const mid = seg.start + (seg.end - seg.start) / 2;
    frames.push({ idx: seg.idx, base64: await extractFrameAtTime(ST.mediaFile, mid) });
    setSegDone(seg.idx);
  }

  // Fase 3 — batch Vision
  renderSegDots(total);
  const batches = [];
  for (let i = 0; i < frames.length; i += CFG.PROMPT_BATCH_SIZE) batches.push(frames.slice(i, i + CFG.PROMPT_BATCH_SIZE));

  const allPrompts = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    setProgress(63 + (b / batches.length) * 28, `Lote ${b + 1}/${batches.length} → Groq Vision…`);
    addLog(`↳ Lote ${b + 1}/${batches.length}: ${batch.length} frames…`, 'info');
    batch.forEach(f => setSegActive(f.idx));
    const prevCtx = allPrompts.length ? allPrompts.slice(-3).map((p, i) => `[Parte ${allPrompts.length - 2 + i}] ${p}`).join('\n') : null;
    const prompts = await groqVisionPromptsAll(batch, prevCtx);
    allPrompts.push(...prompts);
    batch.forEach(f => setSegDone(f.idx));
    if (b < batches.length - 1) await sleep(1500);
  }

  setProgress(93, 'Salvando prompts…');
  const save = shouldSaveTxt();
  for (let i = 0; i < total; i++) {
    const prompt = allPrompts[i] || '—';
    pushTextOutput(segs[i].idx, prompt, save);
    addLog(`  ✓ Parte ${segs[i].idx}`, 'success');
  }
}

async function runAudioCombinedMode(segs) {
  requireApiKey();
  const total = segs.length;
  addLog(`Modo Conjunto (áudio) — ${total} partes…`, 'info');
  await writeInputToFFmpeg(ST.mediaFile);

  // Fase 1 — cortar áudio
  for (let i = 0; i < total; i++) {
    const seg = segs[i];
    setSegActive(seg.idx);
    setProgress((i / total) * 35, `Cortando Parte ${seg.idx}/${total}…`);
    const blob = await cutSegment(seg.start, seg.end, seg.idx);
    ST.outputFiles.push({ name: `Parte ${seg.idx}.mp3`, blob, type: 'audio' });
    ST.doneSegs++;
    setSegDone(seg.idx);
    addLog(`✓ Parte ${seg.idx}.mp3 (${fmtSize(blob.size)})`, 'success');
  }

  // Fase 2 — transcrever (modo rápido: 1 chamada para tudo)
  renderSegDots(total);
  let transcriptions = null;
  try {
    addLog(`Transcrevendo ${total} partes (modo rápido — 1 chamada)…`, 'info');
    transcriptions = await transcribeAllFast(segs);
    transcriptions.forEach(t => setSegDone(t.idx));
  } catch (err) {
    addLog('Modo rápido falhou: ' + errMsg(err) + ' — usando modo lento.', 'warn');
  }

  if (!transcriptions) {
    transcriptions = [];
    addLog(`Modo lento: ${total} chamadas Whisper…`, 'info');
    for (let i = 0; i < total; i++) {
      const seg = segs[i];
      setSegActive(seg.idx);
      setProgress(37 + (i / total) * 30, `Transcrevendo ${i + 1}/${total}…`);
      const audioBlob = await extractAudioSegment(seg.start, seg.end, seg.idx);
      const text      = await groqTranscribe(audioBlob);
      transcriptions.push({ idx: seg.idx, text: text || '[sem fala]' });
      setSegDone(seg.idx);
      if (i < total - 1) await sleep(3500);
    }
  }
  unlinkInput();

  // Fase 3 — prompts texto
  renderSegDots(total);
  const batches = [];
  for (let i = 0; i < transcriptions.length; i += CFG.TEXT_BATCH_SIZE) batches.push(transcriptions.slice(i, i + CFG.TEXT_BATCH_SIZE));

  const allPrompts = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    setProgress(68 + (b / batches.length) * 24, `Gerando prompts lote ${b + 1}/${batches.length}…`);
    batch.forEach(t => setSegActive(t.idx));
    const prevCtx = allPrompts.length ? allPrompts.slice(-3).join('\n') : null;
    const prompts = await groqTextPromptsAll(batch, prevCtx);
    allPrompts.push(...prompts);
    batch.forEach(t => setSegDone(t.idx));
    if (b < batches.length - 1) await sleep(1500);
  }

  setProgress(93, 'Salvando prompts…');
  const save = shouldSaveTxt();
  for (let i = 0; i < total; i++) {
    const prompt = allPrompts[i] || '—';
    pushTextOutput(segs[i].idx, prompt, save);
    addLog(`  ✓ Parte ${segs[i].idx}`, 'success');
  }
}

// ─── MAIN ENTRY ──────────────────────────────────
async function processMedia() {
  const hasFile = IS_TAURI ? !!ST.inputPath : !!ST.mediaFile;
  if (!hasFile)      return showToast('Selecione um arquivo primeiro.', 'error');
  if (!ST.mode)      return showToast('Escolha um modo de processamento.', 'error');
  if (!ffmpegReady)  return showToast('FFmpeg ainda não está pronto.', 'error');

  const needsApi = ST.mode !== 'cut';
  if (needsApi && !ST.apiKey) return showToast('Insira sua chave de API Groq nas configurações.', 'error');

  ST.outputFiles     = [];
  ST.generatedTexts  = [];
  ST.generatedImages = [];
  ST.doneSegs        = 0;
  $('image-config-panel').style.display = 'none';
  $('images-panel').style.display = 'none';
  $('images-grid').innerHTML = '';

  // Cria sessão temporária no Tauri
  if (IS_TAURI) tauriSession = crypto.randomUUID();

  const processBtn = $('process-btn');
  processBtn.classList.add('loading');
  processBtn.disabled = true;

  // Reset visual completo antes de iniciar
  $('progress-section').classList.add('visible');
  $('results-section').classList.remove('visible');
  $('log-console').innerHTML = '';
  $('progress-bar-fill').style.width = '0%';
  $('progress-pct').textContent = '0%';
  $('progress-label').textContent = 'Iniciando…';
  $('progress-segments').innerHTML = '';

  try {
    const duration = await getMediaDuration(ST.mediaFile);
    const limit    = getDurationLimit();

    // Em Tauri, não há limitação de tamanho (FFmpeg nativo usa disco)
    // Em WASM, verifica o tamanho do arquivo
    if (!IS_TAURI && ST.inputSize > FILE_SIZE_LIMITS.block) {
      throw new Error(
        `Arquivo muito grande (${fmtSize(ST.mediaFile.size)}) — limite para processamento no navegador: ${fmtSize(FILE_SIZE_LIMITS.block)}. ` +
        `Comprima o vídeo antes de enviar.`
      );
    }

    // Verifica duração
    if (duration > limit) {
      throw new Error(
        `Arquivo muito longo — ${fmtTime(duration)}. ` +
        `Limite para este modo: ${fmtTime(limit)}. ` +
        `Tente um arquivo menor ou escolha outro modo.`
      );
    }

    // Aviso de arquivo grande só no modo WASM (Tauri não tem limitação)
    if (!IS_TAURI && ST.inputSize > FILE_SIZE_LIMITS.warn && ST.mode !== 'cut') {
      addLog(`⚠ Arquivo grande (${fmtSize(ST.inputSize)}) — processamento pode ser lento no navegador. Aguarde.`, 'warn');
    }

    const segs = calcSegments(duration, ST.segDur);
    ST.totalSegs = segs.length;
    renderSegDots(segs.length);
    setProgress(0, `Iniciando (${segs.length} partes, ${fmtTime(duration)})…`);
    addLog(`Mídia: ${fmtTime(duration)} | ${segs.length} segmentos de ${ST.segDur}s | Tipo: ${ST.inputType}`, 'info');

    if (ST.inputType === 'video') {
      switch (ST.mode) {
        case 'cut':       await runCutMode(segs); break;
        case 'transcribe':await runTranscribeMode(segs); break;
        case 'prompts':   await runVideoPromptsMode(segs); break;
        case 'combined':  await runVideoCombinedMode(segs); break;
      }
    } else {
      switch (ST.mode) {
        case 'cut':       await runCutMode(segs); break;
        case 'transcribe':await runTranscribeMode(segs); break;
        case 'prompts':   await runAudioPromptsMode(segs); break;
        case 'combined':  await runAudioCombinedMode(segs); break;
      }
    }

    setProgress(100, 'Concluído!');
    showResults();
    showToast('Processamento concluído!', 'success');
  } catch (err) {
    console.error(err);
    addLog('ERRO: ' + errMsg(err), 'error');
    showToast('Erro: ' + errMsg(err), 'error');
  } finally {
    processBtn.classList.remove('loading');
    processBtn.disabled = false;
    // Limpa arquivos temporários da sessão Tauri
    if (IS_TAURI && tauriSession) {
      tauriInvoke('clean_session', { sessionId: tauriSession }).catch(() => {});
      tauriSession = null;
    }
  }
}

// ─── VIDEO → AUDIO CONVERTER ─────────────────────
async function runConverter() {
  const fileInput = $('conv-file-input');
  const format    = $('conv-format').value;
  const btn       = $('conv-btn');
  const log       = $('conv-log');

  if (!fileInput.files[0]) return showToast('Selecione um vídeo para converter.', 'error');
  if (!ffmpegReady)         return showToast('FFmpeg ainda não está pronto.', 'error');

  const file = fileInput.files[0];
  btn.disabled = true;
  btn.textContent = 'Convertendo…';
  log.textContent = '';

  const convLog = msg => { log.textContent += msg + '\n'; };

  try {
    const { fetchFile } = FFmpeg;
    const inputExt = getInputExtension(file);
    convLog(`Carregando "${file.name}"…`);
    ffmpegInst.FS('writeFile', `conv_input.${inputExt}`, await fetchFile(file));

    const outName = `audio_out.${format}`;
    convLog(`Convertendo para ${format.toUpperCase()}…`);

    if (format === 'mp3') {
      await ffmpegRun('-i', `conv_input.${inputExt}`, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', outName);
    } else if (format === 'wav') {
      await ffmpegRun('-i', `conv_input.${inputExt}`, '-vn', '-ar', '44100', '-ac', '2', outName);
    } else if (format === 'm4a') {
      await ffmpegRun('-i', `conv_input.${inputExt}`, '-vn', '-c:a', 'aac', '-b:a', '192k', outName);
    }

    const data = ffmpegInst.FS('readFile', outName);
    ffmpegInst.FS('unlink', outName);
    try { ffmpegInst.FS('unlink', `conv_input.${inputExt}`); } catch (_) {}

    const types   = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };
    const blob    = new Blob([data.buffer], { type: types[format] });
    const outFile = file.name.replace(/\.[^.]+$/, '') + '.' + format;
    triggerDownload(blob, outFile);
    convLog(`✓ Convertido: ${outFile} (${fmtSize(blob.size)})`);
    showToast(`Áudio baixado: ${outFile}`, 'success');
  } catch (err) {
    convLog('ERRO: ' + errMsg(err));
    showToast('Erro na conversão: ' + errMsg(err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🎵 Converter e Baixar';
  }
}

// ─── OUTPUT ──────────────────────────────────────
async function downloadZip() {
  if (!ST.outputFiles.length) return;
  showToast('Gerando ZIP…', 'info');
  const zip = new JSZip();
  for (const f of ST.outputFiles) zip.file(f.name, f.blob);
  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, 'Zabiss-Editor-Output.zip');
  showToast('ZIP baixado!', 'success');
}

async function saveToFolder() {
  if (IS_TAURI) {
    // Tauri: diálogo nativo de pasta
    const destDir = await window.__TAURI__.dialog.open({
      directory: true, multiple: false, title: 'Escolha onde salvar os arquivos',
    });
    if (!destDir) return;
    showToast(`Salvando ${ST.outputFiles.length} arquivos…`, 'info');
    const sep = destDir.includes('\\') ? '\\' : '/';
    for (const f of ST.outputFiles) {
      const bytes = Array.from(new Uint8Array(await f.blob.arrayBuffer()));
      await tauriInvoke('write_file_bytes', { path: destDir + sep + f.name, data: bytes });
    }
    await tauriInvoke('open_folder', { path: destDir });
    showToast('Arquivos salvos! Pasta aberta.', 'success');
    return;
  }
  // Browser: File System Access API
  if (!window.showDirectoryPicker) return showToast('Use "Baixar ZIP" — seu navegador não suporta seleção de pasta.', 'warn');
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    showToast(`Salvando ${ST.outputFiles.length} arquivos…`, 'info');
    for (const f of ST.outputFiles) {
      const fh = await dir.getFileHandle(f.name, { create: true });
      const wr = await fh.createWritable();
      await wr.write(f.blob);
      await wr.close();
    }
    showToast('Todos os arquivos salvos!', 'success');
  } catch (err) {
    if (err?.name !== 'AbortError') showToast('Erro ao salvar: ' + errMsg(err), 'error');
  }
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── UI HELPERS ──────────────────────────────────
function setProgress(pct, label) {
  $('progress-bar-fill').style.width = pct + '%';
  $('progress-pct').textContent = Math.round(pct) + '%';
  if (label) $('progress-label').textContent = label;
}

function renderSegDots(count) {
  const container = $('progress-segments');
  container.innerHTML = '';
  const show = Math.min(count, 60);
  for (let i = 1; i <= show; i++) {
    const dot = document.createElement('div');
    dot.className = 'seg-dot'; dot.id = `seg-dot-${i}`; dot.title = `Parte ${i}`;
    container.appendChild(dot);
  }
}

function setSegActive(idx) { const d = $(`seg-dot-${idx}`); if (d) d.className = 'seg-dot active'; }
function setSegDone(idx)   { const d = $(`seg-dot-${idx}`); if (d) d.className = 'seg-dot done'; }

function addLog(msg, type = 'info') {
  const el    = $('log-console');
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  const ts = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = `<span style="opacity:0.4">[${ts}]</span> ${escHtml(msg)}`;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

async function populatePromptsPanel() {
  const panel = $('prompts-panel');
  const list  = $('prompts-list');
  const title = $('prompts-panel-title');

  // Pega todos os textos gerados (do generatedTexts, independente de salvar como .txt)
  const items = (ST.generatedTexts || []).slice();
  if (!items.length) {
    panel.style.display = 'none';
    return;
  }

  // Define título conforme o modo
  if (ST.mode === 'transcribe') title.textContent = 'Transcrições por parte';
  else if (ST.mode === 'prompts' || ST.mode === 'combined') title.textContent = 'Prompts gerados';
  else title.textContent = 'Conteúdo gerado';

  // Mostra botão "Gerar imagens" só pra modos de prompts
  const showGenImg = (ST.mode === 'prompts' || ST.mode === 'combined');
  $('btn-gen-images').style.display = showGenImg ? '' : 'none';

  list.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.innerHTML = `
      <div class="prompt-card-header">
        <span class="prompt-card-num">${escHtml(item.name)}</span>
        <button class="btn-copy" type="button">
          <span>📋</span><span class="copy-label">Copiar</span>
        </button>
      </div>
      <div class="prompt-card-text">${escHtml(item.text)}</div>
    `;

    const btn = card.querySelector('.btn-copy');
    const lbl = card.querySelector('.copy-label');
    btn.addEventListener('click', async () => {
      const ok = await copyToClipboard(item.text);
      if (ok) {
        btn.classList.add('copied');
        lbl.textContent = 'Copiado!';
        setTimeout(() => { btn.classList.remove('copied'); lbl.textContent = 'Copiar'; }, 1500);
      } else {
        showToast('Falha ao copiar — selecione e copie manualmente.', 'error');
      }
    });

    list.appendChild(card);
  }

  // Botão "Copiar tudo": junta com cabeçalhos de parte
  const allText = items.map(i => `[${i.name}]\n${i.text}`).join('\n\n');
  const btnAll = $('btn-copy-all');
  // Remove listener anterior clonando
  const newBtn = btnAll.cloneNode(true);
  btnAll.parentNode.replaceChild(newBtn, btnAll);
  newBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(allText);
    if (ok) {
      newBtn.classList.add('copied');
      newBtn.innerHTML = '<span>✓</span><span>Tudo copiado!</span>';
      setTimeout(() => {
        newBtn.classList.remove('copied');
        newBtn.innerHTML = '<span>📋</span><span>Copiar tudo</span>';
      }, 2000);
    } else {
      showToast('Falha ao copiar tudo.', 'error');
    }
  });

  panel.style.display = 'block';
}

// ─── GERAÇÃO DE IMAGENS (Pollinations.ai) ────────────────────

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt/';

// Traduz prompts em lote para inglês via Groq (resultados melhores na geração)
async function translatePromptsToEnglish(prompts) {
  if (!ST.apiKey) throw new Error('Chave Groq necessária para tradução automática.');

  const numbered = prompts.map((p, i) => `${i + 1}. ${p}`).join('\n\n');
  const userMsg = [
    `Translate these image prompts from Portuguese to English.`,
    `Keep all visual details (lighting, colors, composition, style words) vivid and explicit.`,
    `Do NOT add or remove content — just translate faithfully.`,
    `Respond ONLY with JSON: {"translations":["...","..."]}`,
    `The array must have exactly ${prompts.length} items in the same order.`,
    ``,
    `Prompts:`,
    numbered,
  ].join('\n');

  const res = await groqFetch(() => fetch(`${CFG.GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ST.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CFG.GROQ_TEXT,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: prompts.length * 250 + 100,
      temperature: 0.3,
    }),
  }), 'Groq Translation');

  const json = await res.json();
  const raw  = (json.choices?.[0]?.message?.content || '').trim();

  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      const arr = obj.translations ?? obj.translated ?? Object.values(obj).find(Array.isArray);
      if (Array.isArray(arr) && arr.length) {
        return padArray(arr.map(String), prompts.length);
      }
    }
  } catch (_) {}

  throw new Error('Não foi possível interpretar tradução.');
}

// Gera UMA imagem via Pollinations com retry em caso de rate limit (429).
// onWait recebe segundos restantes pra mostrar contagem na UI.
async function generateOneImage(prompt, opts, onWait) {
  const [w, h] = opts.aspect.split('x').map(Number);
  const params = new URLSearchParams({
    width:    String(w),
    height:   String(h),
    model:    opts.model,
    nologo:   'true',
    seed:     String(opts.seed),
    referrer: 'zabiss-editor', // identifica o app — Pollinations dá rate limit melhor
  });
  const url = `${POLLINATIONS_BASE}${encodeURIComponent(prompt)}?${params}`;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 120_000);

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);

      // Rate limit: espera e tenta de novo (10s, 25s, 50s)
      if (res.status === 429) {
        if (attempt >= maxAttempts) throw new Error('Pollinations rate limit (429) — tente novamente daqui alguns minutos.');
        const waitSec = [10, 25, 50][attempt - 1] || 60;
        if (onWait) onWait(waitSec, attempt, maxAttempts);
        for (let s = waitSec; s > 0; s--) {
          if (onWait) onWait(s, attempt, maxAttempts);
          await sleep(1000);
        }
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!blob.type.startsWith('image/')) throw new Error('Resposta não é imagem');
      return blob;
    } catch (err) {
      clearTimeout(tid);
      const msg = errMsg(err);
      // Se for timeout ou erro de rede, retry curto
      if (attempt < maxAttempts && (err.name === 'AbortError' || msg.includes('Failed to fetch') || msg.includes('NetworkError'))) {
        await sleep(3000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Falha após todas as tentativas');
}

// Processa lista com concorrência limitada (Pollinations bloqueia se hammer demais)
async function processConcurrent(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: errMsg(err) };
      }
    }
  }
  await Promise.all(Array(Math.min(concurrency, items.length)).fill(0).map(() => worker()));
  return results;
}

// Compõe prompt final juntando estilo + personagem + texto da parte
function composePrompt(baseText, style, character) {
  const parts = [];
  if (character?.trim()) parts.push(character.trim());
  parts.push(baseText.trim());
  if (style?.trim()) parts.push(style.trim());
  return parts.join(', ');
}

// Inicia geração: lê configs, traduz se preciso, dispara concurrent
async function startImageGeneration() {
  const items = (ST.generatedTexts || []).slice();
  if (!items.length) return showToast('Não há prompts para gerar imagens.', 'error');

  // Coleta opções
  const aspect    = $('img-aspect').value;
  const model     = $('img-model').value;
  const translate = $('img-translate').checked;
  const style     = $('img-style').value.trim();
  const character = $('img-character').value.trim();
  const seed      = Math.floor(Math.random() * 1_000_000);

  // Fecha config, mostra panel de imagens
  $('image-config-panel').style.display = 'none';
  $('btn-gen-images').disabled = true;
  $('images-panel').style.display = 'block';
  $('images-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const grid = $('images-grid');
  grid.innerHTML = '';
  ST.generatedImages = [];

  // Cria cards placeholder
  items.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'image-card';
    card.id = `img-card-${i}`;
    card.innerHTML = `
      <div class="image-card-preview">
        <div class="image-card-loading">
          <div class="image-card-spinner"></div>
          <span>Aguardando…</span>
        </div>
        <div class="image-card-status" id="img-status-${i}">Fila</div>
      </div>
      <div class="image-card-info">
        <span class="image-card-name">${escHtml(item.name)}</span>
        <div class="image-card-actions">
          <button class="image-card-btn" disabled title="Baixar">⬇</button>
          <button class="image-card-btn" disabled title="Ver prompt">💬</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  // Traduz se solicitado
  let textsForImage = items.map(i => i.text);
  if (translate) {
    $('images-panel-sub').textContent = 'Traduzindo prompts para inglês…';
    try {
      textsForImage = await translatePromptsToEnglish(textsForImage);
      addLog('Prompts traduzidos para inglês ✓', 'success');
    } catch (err) {
      addLog('Tradução falhou: ' + errMsg(err) + ' — usando prompts originais.', 'warn');
    }
  }

  // Pollinations tem rate limit estrito — gera 1 por vez com delay
  const DELAY_BETWEEN = 5000; // 5s entre cada imagem
  const estTime = Math.ceil((items.length * (15 + DELAY_BETWEEN / 1000)) / 60);
  $('images-panel-sub').textContent = `Gerando ${items.length} imagens (~${estTime} min, sequencial)…`;
  addLog(`Geração de imagens: ${items.length} imagens, ~${estTime} min estimados.`, 'info');

  let doneCount = 0;
  const updateSub = () => {
    $('images-panel-sub').textContent = `${doneCount}/${items.length} prontas`;
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const card = $(`img-card-${i}`);
    const status = $(`img-status-${i}`);
    const loadingLabel = card.querySelector('.image-card-loading span');

    status.textContent = 'Gerando…';
    loadingLabel.textContent = 'Gerando…';

    const finalPrompt = composePrompt(textsForImage[i], style, character);

    // Callback para mostrar countdown durante espera de rate limit
    const onWait = (sec, attempt, max) => {
      status.textContent = `Aguardando ${sec}s`;
      loadingLabel.textContent = `Rate limit — esperando ${sec}s (tentativa ${attempt}/${max})`;
    };

    try {
      const blob = await generateOneImage(finalPrompt, { aspect, model, seed: seed + i }, onWait);
      const url = URL.createObjectURL(blob);

      const preview = card.querySelector('.image-card-preview');
      preview.innerHTML = `
        <img src="${url}" alt="${escHtml(it.name)}" loading="lazy" />
        <div class="image-card-status done">✓</div>
      `;
      const actions = card.querySelectorAll('.image-card-btn');
      actions.forEach(b => { b.disabled = false; });
      actions[0].onclick = () => triggerDownload(blob, `${it.name}.jpg`);
      actions[1].onclick = () => alert(`Prompt usado:\n\n${finalPrompt}`);

      ST.generatedImages[i] = { idx: it.idx, name: it.name, blob, ok: true };
      addLog(`✓ ${it.name} gerada`, 'success');
    } catch (err) {
      const msg = errMsg(err);
      addLog(`✗ ${it.name}: ${msg}`, 'error');
      const preview = card.querySelector('.image-card-preview');
      preview.innerHTML = `
        <div class="image-card-error">
          ❌ Falhou<br><span style="opacity:0.7">${escHtml(msg.slice(0, 80))}</span>
        </div>
        <div class="image-card-status error">!</div>
      `;
      ST.generatedImages[i] = { idx: it.idx, name: it.name, ok: false, error: msg };
    } finally {
      doneCount++;
      updateSub();
    }

    // Delay entre imagens — exceto na última
    if (i < items.length - 1) {
      const nextStatus = $(`img-status-${i + 1}`);
      const nextLabel = $(`img-card-${i + 1}`).querySelector('.image-card-loading span');
      for (let s = DELAY_BETWEEN / 1000; s > 0; s--) {
        nextStatus.textContent = `Em ${s}s`;
        nextLabel.textContent = `Próxima em ${s}s…`;
        await sleep(1000);
      }
    }
  }

  // Resultado final
  const okCount = ST.generatedImages.filter(x => x?.ok).length;
  const failCount = items.length - okCount;
  $('images-panel-sub').textContent = failCount
    ? `${okCount}/${items.length} prontas · ${failCount} falharam`
    : `${okCount}/${items.length} prontas — todas geradas!`;
  $('btn-retry-failed').style.display = failCount ? '' : 'none';

  $('btn-gen-images').disabled = false;
  if (okCount > 0) showToast(`${okCount} imagens geradas!`, 'success');
}

async function downloadAllImages() {
  const ok = (ST.generatedImages || []).filter(x => x?.ok);
  if (!ok.length) return showToast('Nenhuma imagem para baixar.', 'error');
  showToast(`Gerando ZIP com ${ok.length} imagens…`, 'info');
  const zip = new JSZip();
  for (const img of ok) zip.file(`${img.name}.jpg`, img.blob);
  const content = await zip.generateAsync({ type: 'blob' });
  triggerDownload(content, 'Zabiss-Imagens.zip');
  showToast('ZIP baixado!', 'success');
}

async function retryFailedImages() {
  const failed = (ST.generatedImages || [])
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => x && !x.ok);
  if (!failed.length) return;

  const aspect    = $('img-aspect').value;
  const model     = $('img-model').value;
  const seed      = Math.floor(Math.random() * 1_000_000);
  const style     = $('img-style').value.trim();
  const character = $('img-character').value.trim();

  for (let k = 0; k < failed.length; k++) {
    const { i } = failed[k];
    const item = ST.generatedTexts[i];
    if (!item) continue;
    const card = $(`img-card-${i}`);
    const preview = card.querySelector('.image-card-preview');
    preview.innerHTML = `
      <div class="image-card-loading">
        <div class="image-card-spinner"></div>
        <span class="image-card-loading-label">Tentando de novo…</span>
      </div>
    `;
    const status = card.querySelector('.image-card-status') || (() => {
      const s = document.createElement('div');
      s.className = 'image-card-status';
      preview.appendChild(s);
      return s;
    })();
    const lbl = preview.querySelector('.image-card-loading-label');

    const onWait = (sec) => {
      status.textContent = `Aguardando ${sec}s`;
      if (lbl) lbl.textContent = `Rate limit — ${sec}s…`;
    };

    try {
      const finalPrompt = composePrompt(item.text, style, character);
      const blob = await generateOneImage(finalPrompt, { aspect, model, seed: seed + i }, onWait);
      const url = URL.createObjectURL(blob);
      preview.innerHTML = `<img src="${url}" loading="lazy"/><div class="image-card-status done">✓</div>`;
      const actions = card.querySelectorAll('.image-card-btn');
      actions.forEach(b => { b.disabled = false; });
      actions[0].onclick = () => triggerDownload(blob, `${item.name}.jpg`);
      ST.generatedImages[i] = { idx: item.idx, name: item.name, blob, ok: true };
    } catch (err) {
      preview.innerHTML = `<div class="image-card-error">❌ ${escHtml(errMsg(err).slice(0, 80))}</div>`;
    }

    // Delay entre retries também
    if (k < failed.length - 1) await sleep(5000);
  }

  const okCount = ST.generatedImages.filter(x => x?.ok).length;
  $('images-panel-sub').textContent = `${okCount}/${ST.generatedImages.length} prontas`;
  if (okCount === ST.generatedImages.length) $('btn-retry-failed').style.display = 'none';
}

function showResults() {
  const section  = $('results-section');
  const fileList = $('file-list');
  section.classList.add('visible');
  fileList.innerHTML = '';

  let videoCount = 0, audioCount = 0, textCount = 0, totalSize = 0;

  for (const f of ST.outputFiles) {
    totalSize += f.blob.size;
    if (f.type === 'video') videoCount++;
    else if (f.type === 'audio') audioCount++;
    else textCount++;

    const isMedia = f.type === 'video' || f.type === 'audio';
    const icon = f.type === 'video' ? '🎬' : f.type === 'audio' ? '🎵' : '📝';
    const iconClass = isMedia ? 'icon-video' : 'icon-text';
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-item-icon ${iconClass}">${icon}</div>
      <div class="file-item-info">
        <div class="file-item-name">${escHtml(f.name)}</div>
        <div class="file-item-meta">${f.type === 'video' ? 'Segmento de vídeo' : f.type === 'audio' ? 'Segmento de áudio' : 'Arquivo de texto'}</div>
      </div>
      <div class="file-item-size">${fmtSize(f.blob.size)}</div>`;
    fileList.appendChild(item);
  }

  const stats = [];
  if (videoCount) stats.push(`<span class="stat-pill stat-videos">🎬 ${videoCount} vídeos</span>`);
  if (audioCount) stats.push(`<span class="stat-pill stat-videos" style="background:rgba(6,182,212,.15);color:var(--cyan-light)">🎵 ${audioCount} áudios</span>`);
  if (textCount)  stats.push(`<span class="stat-pill stat-texts">📝 ${textCount} textos</span>`);
  stats.push(`<span class="stat-pill stat-size">📦 ${fmtSize(totalSize)}</span>`);
  $('results-stats').innerHTML = stats.join('');

  // Se não há arquivos para baixar mas há textos no painel, esconde card de arquivos
  const hasFiles = ST.outputFiles.length > 0;
  const hasTexts = (ST.generatedTexts || []).length > 0;
  $('results-card-wrap').style.display = hasFiles ? '' : 'none';

  if (hasFiles) {
    $('results-title').textContent = `${ST.outputFiles.length} arquivo${ST.outputFiles.length !== 1 ? 's' : ''} gerado${ST.outputFiles.length !== 1 ? 's' : ''}`;
  }

  // Se há textos sem arquivos para baixar, garante que o botão "Novo processamento" fique visível
  $('btn-new-standalone').style.display = (!hasFiles && hasTexts) ? '' : 'none';

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Popula painel de textos com botões de copiar (async, não bloqueia)
  populatePromptsPanel().catch(e => console.error('Erro ao popular painel:', e));
}

function showToast(msg, type = 'info') {
  const container = $('toast-container');
  const toast     = document.createElement('div');
  const icons     = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' };
  toast.className = `toast toast-${type === 'warn' ? 'error' : type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${escHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('out'); setTimeout(() => toast.remove(), 300); }, 4000);
}

function requireApiKey() {
  if (!ST.apiKey) throw new Error('Chave de API Groq não configurada.');
}

// ─── MEDIA UPLOAD UI ─────────────────────────────
function handleMediaFile(file) {
  const isVideo = file.type.startsWith('video/');
  const isAudio = file.type.startsWith('audio/');

  if (!isVideo && !isAudio) {
    showToast('Selecione um arquivo de vídeo ou áudio válido.', 'error');
    return;
  }

  // Auto-switch media type toggle to match file
  const detectedType = isAudio ? 'audio' : 'video';
  if (ST.inputType !== detectedType) {
    setInputType(detectedType);
  }

  ST.mediaFile = file;
  ST.inputExt  = getInputExtension(file);
  ST.inputSize = file.size;

  const zone = $('upload-zone');
  zone.classList.add('has-file');
  $('video-name').textContent = file.name;
  $('video-meta').textContent = fmtSize(file.size);

  // Stats
  const el = isAudio ? new Audio() : document.createElement('video');
  el.preload = 'metadata';
  el.onloadedmetadata = () => {
    const dur  = el.duration;
    const segs = Math.ceil(dur / ST.segDur);
    $('video-stat-dur').textContent  = `⏱ ${fmtTime(dur)}`;
    $('video-stat-size').textContent = `💾 ${fmtSize(file.size)}`;
    $('video-stat-segs').textContent = `✂ ${segs} partes`;
    URL.revokeObjectURL(el.src);

    // Avisos de duração e tamanho
    const limitEl  = $('duration-warning');
    const warnings = [];
    if (dur > LIMITS.cut) warnings.push('Corte: limite 2h');
    if (dur > LIMITS.ai)  warnings.push('Modos com IA: limite 50min');
    if (file.size > FILE_SIZE_LIMITS.block) warnings.push(`Arquivo muito grande (${fmtSize(file.size)}) — comprima antes`);
    else if (file.size > FILE_SIZE_LIMITS.warn) warnings.push(`Arquivo grande (${fmtSize(file.size)}) — pode ser lento`);

    if (warnings.length) {
      limitEl.textContent = `⚠ ${warnings.join(' · ')}`;
      limitEl.style.display = '';
    } else {
      limitEl.style.display = 'none';
    }
  };
  el.src = URL.createObjectURL(file);

  // Thumbnail (vídeo) ou waveform visual (áudio)
  if (isVideo) {
    const thumbVid = document.createElement('video');
    thumbVid.onloadedmetadata = () => { thumbVid.currentTime = Math.min(2, thumbVid.duration * 0.1); };
    thumbVid.onseeked = () => {
      const cvs = document.createElement('canvas');
      cvs.width = 240; cvs.height = 135;
      cvs.getContext('2d').drawImage(thumbVid, 0, 0, 240, 135);
      $('video-thumb').src = cvs.toDataURL('image/jpeg', 0.7);
      $('video-thumb').style.display = '';
      $('audio-thumb').style.display = 'none';
      URL.revokeObjectURL(thumbVid.src);
    };
    thumbVid.src = URL.createObjectURL(file);
  } else {
    $('video-thumb').style.display = 'none';
    $('audio-thumb').style.display = '';
  }

  $('upload-preview-area').style.display = 'block';
  $('upload-default-area').style.display = 'none';
  addLog(`${isAudio ? 'Áudio' : 'Vídeo'} carregado: ${file.name} (${fmtSize(file.size)})`, 'success');
}

function setInputType(type) {
  ST.inputType = type;
  // Update toggle buttons
  $$$('.media-type-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.type === type));
  // Update accept attribute
  $('file-input').accept = type === 'audio' ? 'audio/*' : 'video/*,audio/*';
  // Update upload zone icon/text
  $('upload-icon-el').textContent = type === 'audio' ? '🎵' : '🎬';
  $('upload-title-el').textContent = type === 'audio' ? 'Arraste seu áudio aqui' : 'Arraste seu vídeo aqui';
  $('upload-sub-el').textContent   = type === 'audio' ? 'MP3, WAV, M4A, OGG, FLAC e outros formatos de áudio' : 'MP4, MOV, AVI, WebM e outros formatos de vídeo';
  // Update process button label
  $('process-btn-label').textContent = type === 'audio' ? 'Processar Áudio' : 'Processar Vídeo';
  // Update mode cards
  updateModeCards();
  // Clear current file if switching types
  if (ST.mediaFile) {
    const wasAudio = ST.mediaFile.type.startsWith('audio/');
    if ((type === 'audio') !== wasAudio) resetUpload();
  }
}

function updateModeCards() {
  const modes = MODE_DESCRIPTIONS[ST.inputType] || MODE_DESCRIPTIONS.video;
  $$$('.mode-card').forEach(card => {
    const m = modes[card.dataset.mode];
    if (!m) return;
    card.querySelector('.mode-icon').textContent = m.icon;
    card.querySelector('.mode-name').textContent = m.name;
    card.querySelector('.mode-desc').innerHTML   = m.desc.replace(/N/g, ST.segDur);
    const badge = card.querySelector('.mode-badge');
    badge.className   = 'mode-badge ' + m.badge;
    badge.textContent = m.badgeText;
  });
}

// ─── SELEÇÃO NATIVA DE ARQUIVO (TAURI) ───────────────────────
async function selectMediaFileNative() {
  try {
    // Filtra por tipo de mídia conforme o modo selecionado
    const audioExts = ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'wma'];
    const videoExts = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'wmv', 'm4v', 'flv'];
    const filters   = ST.inputType === 'audio'
      ? [{ name: 'Áudio', extensions: audioExts }, { name: 'Todos', extensions: ['*'] }]
      : [
          { name: 'Vídeo e Áudio', extensions: [...videoExts, ...audioExts] },
          { name: 'Todos', extensions: ['*'] },
        ];

    const selected = await window.__TAURI__.dialog.open({
      multiple: false,
      filters,
      title: ST.inputType === 'audio' ? 'Selecione um áudio' : 'Selecione um vídeo ou áudio',
    });
    if (selected && typeof selected === 'string') {
      await loadMediaFromPath(selected);
    }
  } catch (err) {
    showToast('Erro ao selecionar arquivo: ' + errMsg(err), 'error');
  }
}

async function loadMediaFromPath(filePath) {
  if (!filePath) return;

  const ext       = filePath.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
  const audioExts = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'wma']);
  const fileIsAudio = audioExts.has(ext);

  // Se o usuário escolheu o modo Áudio mas pegou um vídeo, mantém o modo Áudio
  // (o áudio será extraído do vídeo). Só auto-troca se for o modo errado óbvio.
  const isAudio = ST.inputType === 'audio' ? true : fileIsAudio;

  ST.inputPath = filePath;
  ST.inputExt  = ext;
  ST.mediaFile = null;

  let info = { name: filePath.replace(/\\/g, '/').split('/').pop(), size: 0 };
  try {
    info = await tauriInvoke('get_file_info', { path: filePath });
    ST.inputSize = Number(info.size);
  } catch (e) {
    addLog('Aviso ao obter info do arquivo: ' + errMsg(e), 'warn');
  }

  // Não muda o tipo de input automaticamente — respeita o que o usuário escolheu

  // Atualiza UI da zona de upload (reusa handleMediaFile mas sem File object)
  const zone = $('upload-zone');
  zone.classList.add('has-file');
  $('video-name').textContent = info.name;
  $('video-meta').textContent = fmtSize(info.size);

  // Pega duração via FFmpeg (Rust) — não depende do webview ler o arquivo
  $('video-stat-size').textContent = `💾 ${fmtSize(info.size)}`;
  $('video-stat-dur').textContent  = '⏱ …';
  $('video-stat-segs').textContent = '✂ …';
  $('duration-warning').style.display = 'none';

  tauriInvoke('get_media_duration', { path: filePath })
    .then(dur => {
      const segs = Math.ceil(dur / ST.segDur);
      $('video-stat-dur').textContent  = `⏱ ${fmtTime(dur)}`;
      $('video-stat-segs').textContent = `✂ ${segs} partes`;
    })
    .catch(e => {
      addLog('Aviso: ' + errMsg(e), 'warn');
      $('video-stat-dur').textContent  = '⏱ —';
      $('video-stat-segs').textContent = '✂ —';
    });

  // Thumbnail via FFmpeg para vídeo, animação CSS para áudio
  if (!isAudio) {
    $('video-thumb').src = '';
    $('video-thumb').style.display = '';
    $('audio-thumb').style.display = 'none';
    tauriInvoke('extract_frame_at', {
      sessionId: 'thumbnail',
      path:      filePath,
      timeSec:   2.0,
    })
      .then(b64 => { $('video-thumb').src = `data:image/jpeg;base64,${b64}`; })
      .catch(() => { /* mantém placeholder */ });
  } else {
    $('video-thumb').style.display = 'none';
    $('audio-thumb').style.display = '';
  }

  $('upload-preview-area').style.display = 'block';
  $('upload-default-area').style.display = 'none';
  addLog(`${isAudio ? 'Áudio' : 'Vídeo'} selecionado: ${info.name} (${fmtSize(info.size)})`, 'success');
}

// ─── INIT ─────────────────────────────────────────
function init() {
  // Links externos: no Tauri abre no navegador padrão do sistema
  if (IS_TAURI) {
    document.addEventListener('click', e => {
      const link = e.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        e.preventDefault();
        window.__TAURI__.shell.open(href).catch(err => {
          addLog('Erro ao abrir link: ' + errMsg(err), 'warn');
        });
      }
    });
  }

  // API key
  $('api-key-input').value = ST.apiKey;
  $('api-key-input').addEventListener('input', e => {
    ST.apiKey = e.target.value.trim();
    localStorage.setItem('zabiss_groq_key', ST.apiKey);
  });
  $('toggle-key').addEventListener('click', () => {
    const inp = $('api-key-input');
    const hidden = inp.type === 'password';
    inp.type = hidden ? 'text' : 'password';
    $('toggle-key').textContent = hidden ? '🙈' : '👁';
  });

  // Segment duration
  $('seg-dur-input').value = ST.segDur;
  $('seg-dur-input').addEventListener('input', e => {
    ST.segDur = Math.max(1, parseInt(e.target.value) || CFG.SEG_DEFAULT);
    updateModeCards();
    if (ST.mediaFile) {
      getMediaDuration(ST.mediaFile).then(d => {
        $('video-stat-segs').textContent = `✂ ${Math.ceil(d / ST.segDur)} partes`;
      }).catch(() => {});
    }
  });

  // Media type toggle
  $$$('.media-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setInputType(btn.dataset.type));
  });

  // Prompt level
  $$$('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$$('.level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ST.promptLevel = parseInt(btn.dataset.level);
      $('level-desc').textContent = PROMPT_LEVELS[ST.promptLevel].label;
    });
  });

  // Checkbox: salvar prompts como .txt
  $('save-txt-checkbox').checked = ST.saveTxtFiles;
  $('save-txt-checkbox').addEventListener('change', e => {
    ST.saveTxtFiles = e.target.checked;
  });

  // Custom prompt
  const customInput   = $('custom-prompt-input');
  const customCounter = $('custom-prompt-len');
  customInput.addEventListener('input', () => {
    const len = customInput.value.length;
    ST.customPrompt = customInput.value;
    customCounter.textContent = len;
    const wrap = customCounter.parentElement;
    wrap.className = 'textarea-counter' + (len > 1400 ? ' full' : len > 1100 ? ' warn' : '');
  });

  // Vision model
  $('model-select').value = CFG.GROQ_VISION;
  $('model-select').addEventListener('change', e => { CFG.GROQ_VISION = e.target.value; });

  // Language
  $('lang-select').value = ST.lang;
  $('lang-select').addEventListener('change', e => { ST.lang = e.target.value; });

  // Settings panel
  $('settings-header').addEventListener('click', () => $('settings-panel').classList.toggle('open'));

  // Mode cards
  $$$('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      $$$('.mode-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      ST.mode = card.dataset.mode;
      updateSettingsVisibility();
      addLog(`Modo: ${card.querySelector('.mode-name').textContent}`, 'info');
    });
  });

  // Upload zone
  const uploadZone  = $('upload-zone');
  const fileInput   = $('file-input');
  const openFilePicker = () => IS_TAURI ? selectMediaFileNative() : fileInput.click();

  uploadZone.addEventListener('click', e => {
    if (e.target.closest('.upload-change-btn') || !uploadZone.classList.contains('has-file')) openFilePicker();
  });
  $('upload-change-btn').addEventListener('click', e => { e.stopPropagation(); openFilePicker(); });

  // Modo browser: input file element
  fileInput.addEventListener('change', e => { if (e.target.files[0]) handleMediaFile(e.target.files[0]); });

  // Drag and drop (funciona em browser e Tauri)
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault(); uploadZone.classList.remove('drag-over');
    if (IS_TAURI) {
      // Tauri: extrai o caminho do arquivo arrastado
      const paths = e.dataTransfer.files;
      if (paths[0]) {
        // Fallback: usa File object do drag mesmo em Tauri
        handleMediaFile(paths[0]);
      }
    } else {
      if (e.dataTransfer.files[0]) handleMediaFile(e.dataTransfer.files[0]);
    }
  });

  // Process button
  $('process-btn').addEventListener('click', processMedia);

  // Results
  $('btn-download-zip').addEventListener('click', downloadZip);
  $('btn-save-folder').addEventListener('click', saveToFolder);
  $('btn-new-process').addEventListener('click', resetAll);
  $('btn-new-standalone').addEventListener('click', resetAll);

  // Geração de imagens
  $('btn-gen-images').addEventListener('click', () => {
    if (!ST.apiKey) {
      showToast('Configure sua chave Groq para tradução (ou desmarque "traduzir").', 'warn');
    }
    $('image-config-panel').style.display = 'block';
    $('image-config-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('image-config-close').addEventListener('click', () => {
    $('image-config-panel').style.display = 'none';
  });
  $('btn-cancel-img-gen').addEventListener('click', () => {
    $('image-config-panel').style.display = 'none';
  });
  $('btn-start-img-gen').addEventListener('click', () => {
    startImageGeneration().catch(err => {
      showToast('Erro: ' + errMsg(err), 'error');
      $('btn-gen-images').disabled = false;
    });
  });
  $('btn-download-all-images').addEventListener('click', downloadAllImages);
  $('btn-retry-failed').addEventListener('click', retryFailedImages);

  // Converter
  const convDrop = $('conv-drop');
  const convFileInput = $('conv-file-input');

  convDrop.addEventListener('click', () => convFileInput.click());
  convFileInput.addEventListener('change', e => {
    if (e.target.files[0]) updateConvPreview(e.target.files[0]);
  });
  convDrop.addEventListener('dragover', e => { e.preventDefault(); convDrop.classList.add('drag-over'); });
  convDrop.addEventListener('dragleave', () => convDrop.classList.remove('drag-over'));
  convDrop.addEventListener('drop', e => {
    e.preventDefault(); convDrop.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) { convFileInput.files; updateConvPreview(f); }
    // manual assign via DataTransfer
    const dt = new DataTransfer();
    if (e.dataTransfer.files[0]) { dt.items.add(e.dataTransfer.files[0]); convFileInput.files = dt.files; }
    if (e.dataTransfer.files[0]) updateConvPreview(e.dataTransfer.files[0]);
  });
  $('conv-btn').addEventListener('click', runConverter);

  // Init mode cards with video descriptions
  updateModeCards();
  loadFFmpeg();
}

function updateConvPreview(file) {
  $('conv-filename').textContent = `${file.name} (${fmtSize(file.size)})`;
  $('conv-file-row').style.display = '';
}

function updateSettingsVisibility() {
  const needsApi    = ST.mode && ST.mode !== 'cut';
  const needsVision = (ST.mode === 'prompts' || ST.mode === 'combined') && ST.inputType === 'video';
  const needsPrompt = ST.mode === 'prompts' || ST.mode === 'combined';
  $('api-key-group').style.display       = needsApi    ? '' : 'none';
  $('level-group').style.display         = needsPrompt ? '' : 'none';
  $('custom-prompt-group').style.display = needsPrompt ? '' : 'none';
  $('output-options-group').style.display = needsPrompt ? '' : 'none';
  $('model-group').style.display         = needsVision ? '' : 'none';
  $('lang-group').style.display          = ST.mode === 'transcribe' ? '' : 'none';
  if (needsApi && !ST.apiKey) { $('settings-panel').classList.add('open'); $('api-key-note').style.display = ''; }
}

function resetUpload() {
  ST.mediaFile = null;
  ST.inputPath = null;
  ST.inputSize = 0;
  $('upload-zone').classList.remove('has-file');
  $('upload-preview-area').style.display = 'none';
  $('upload-default-area').style.display = 'block';
  $('file-input').value = '';
  $('duration-warning').style.display = 'none';
}

function resetAll() {
  resetUpload();
  ST.outputFiles = []; ST.generatedTexts = []; ST.mode = null; ST.doneSegs = 0;
  $$$('.mode-card').forEach(c => c.classList.remove('active'));
  $('progress-section').classList.remove('visible');
  $('results-section').classList.remove('visible');
  $('log-console').innerHTML = '';
  $('progress-bar-fill').style.width = '0%';
  $('progress-segments').innerHTML = '';
  $('prompts-panel').style.display = 'none';
  $('prompts-list').innerHTML = '';
  $('image-config-panel').style.display = 'none';
  $('images-panel').style.display = 'none';
  $('images-grid').innerHTML = '';
  ST.generatedImages = [];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── UTILS ──────────────────────────────────────
function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── VERIFICAÇÃO DE NOVA VERSÃO ──────────────────────────────
async function checkForUpdates(silent = false) {
  if (!IS_TAURI) return;
  try {
    // Busca a última release do GitHub
    const res = await fetch('https://api.github.com/repos/fernandopy26/Zabiss-Editor/releases/latest');
    if (!res.ok) return;
    const release = await res.json();
    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    // Versão atual do app (vem do Cargo.toml via Rust)
    const currentVersion = await tauriInvoke('get_app_version').catch(() => '0.0.0');

    if (!latestVersion || latestVersion === currentVersion) {
      if (!silent) showToast(`Você está na versão mais recente (v${currentVersion}).`, 'success');
      return;
    }

    if (compareVersions(latestVersion, currentVersion) > 0) {
      showUpdateBanner(latestVersion, release.body || 'Nova versão disponível.', release.html_url);
    }
  } catch (_) {
    // Falha silenciosa — pode estar offline
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// Detecta plataforma e escolhe o melhor instalador disponível na release
function selectPlatformAsset(assets) {
  if (!assets || !assets.length) return null;
  const ua = (navigator.userAgent || '').toLowerCase();
  const plat = (navigator.platform || '').toLowerCase();

  let patterns = [];
  if (ua.includes('win') || plat.includes('win')) {
    patterns = [/\.msi$/i, /-setup\.exe$/i, /\.exe$/i];
  } else if (ua.includes('mac') || plat.includes('mac')) {
    patterns = [/\.dmg$/i];
  } else {
    // Linux: prefere AppImage (portável), depois deb
    patterns = [/\.AppImage$/i, /\.deb$/i];
  }

  for (const p of patterns) {
    const match = assets.find(a => p.test(a.name) && !/\.sig$/.test(a.name));
    if (match) return match;
  }
  return null;
}

// Baixa o instalador com progresso e abre direto no SO
async function downloadAndInstallUpdate(asset, btn, releaseUrl) {
  const origHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>📥</span><span>Iniciando…</span>';

  let unlisten = null;
  try {
    // Escuta eventos de progresso emitidos pelo Rust
    if (window.__TAURI__?.event?.listen) {
      unlisten = await window.__TAURI__.event.listen('update-progress', (event) => {
        const { received, total } = event.payload || {};
        const mb = (received / 1024 / 1024).toFixed(1);
        if (total > 0) {
          const pct = Math.round((received / total) * 100);
          const totalMb = (total / 1024 / 1024).toFixed(1);
          btn.innerHTML = `<span>📥</span><span>${pct}% — ${mb}/${totalMb}MB</span>`;
        } else {
          btn.innerHTML = `<span>📥</span><span>Baixado ${mb}MB</span>`;
        }
      });
    }

    const path = await tauriInvoke('download_update_file', {
      url:      asset.browser_download_url,
      filename: asset.name,
    });

    if (unlisten) { try { unlisten(); } catch (_) {} unlisten = null; }

    btn.innerHTML = '<span>📦</span><span>Abrindo instalador…</span>';
    await tauriInvoke('open_installer', { path });

    const isAppImage = /\.AppImage$/i.test(asset.name);
    const msg = isAppImage
      ? 'Arquivo baixado! Feche o Zabiss Editor e execute o novo arquivo na pasta aberta.'
      : 'Instalador aberto! Siga as instruções para concluir a atualização.';
    showToast(msg, 'success');
    btn.innerHTML = '<span>✓</span><span>Pronto!</span>';
  } catch (err) {
    if (unlisten) { try { unlisten(); } catch (_) {} }
    showToast('Erro ao baixar: ' + errMsg(err) + ' — abrindo página de download.', 'warn');
    // Fallback: abre a página de releases
    try {
      await window.__TAURI__.shell.open(releaseUrl);
    } catch (_) {}
    btn.disabled = false;
    btn.innerHTML = origHTML;
  }
}

function showUpdateBanner(version, notes, releaseUrl) {
  const old = document.getElementById('update-banner');
  if (old) old.remove();
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = [
    'position:fixed;bottom:80px;right:30px;z-index:998',
    'background:linear-gradient(135deg,#7c3aed,#06b6d4)',
    'border-radius:16px;padding:16px 20px;max-width:340px',
    'box-shadow:0 8px 32px rgba(124,58,237,.5)',
    'animation:toastIn .3s ease',
  ].join(';');
  // Trunca as notas para não ficar gigante
  const shortNotes = (notes || 'Melhorias e correções.').slice(0, 200);
  banner.innerHTML = `
    <div style="font-weight:700;font-size:15px;color:#fff;margin-bottom:6px">
      🚀 Nova versão disponível: v${escHtml(version)}
    </div>
    <div style="font-size:13px;color:rgba(255,255,255,.85);margin-bottom:14px;line-height:1.5;max-height:80px;overflow:hidden">
      ${escHtml(shortNotes)}
    </div>
    <div style="display:flex;gap:8px">
      <button id="btn-do-update" style="flex:1;padding:9px;background:#fff;color:#7c3aed;border:none;border-radius:50px;font-weight:700;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px">
        <span>⬇</span><span>Baixar e instalar</span>
      </button>
      <button id="btn-update-later" style="padding:9px 14px;background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:50px;font-size:13px;cursor:pointer">
        Depois
      </button>
    </div>`;
  document.body.appendChild(banner);

  document.getElementById('btn-do-update').addEventListener('click', async function() {
    try {
      // Busca info completa da release pra pegar os assets
      const res = await fetch('https://api.github.com/repos/fernandopy26/Zabiss-Editor/releases/latest');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const release = await res.json();
      const asset = selectPlatformAsset(release.assets);

      if (asset) {
        // Download direto no app + abre instalador
        await downloadAndInstallUpdate(asset, this, releaseUrl);
      } else {
        // Fallback: nenhum instalador combina com a plataforma — abre browser
        await window.__TAURI__.shell.open(releaseUrl);
        showToast('Abrindo página de downloads (instalador não detectado).', 'info');
        banner.remove();
      }
    } catch (err) {
      showToast('Erro: ' + errMsg(err), 'error');
    }
  });
  document.getElementById('btn-update-later').addEventListener('click', () => banner.remove());
}

// ─── BOOT ────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();
  if (IS_TAURI) setTimeout(() => checkForUpdates(true), 3000);
});
