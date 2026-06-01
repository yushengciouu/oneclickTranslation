import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type AppMode = "idle" | "selecting" | "selected" | "processing" | "result";
type Lang = "zh" | "en";
type TransDir = "zh-en" | "en-zh";

const SETTINGS_KEY = "screen-translator-settings";
const DEFAULT_SETTINGS = {
  apiUrl: "http://192.168.39.143:8001",
  model: "gemma-4:31B",
};

interface AppSettings {
  apiUrl: string;
  model: string;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const DIR_LABEL: Record<TransDir, string> = { "zh-en": "中→英", "en-zh": "英→中" };

const LOCALE = {
  zh: {
    title: "Screen Translator",
    subtitle: "按 Ctrl+Shift+T 或點按鈕開始截圖翻譯",
    startBtn: "開始截圖",
    hint: "拖曳選取翻譯範圍· Esc 取消",
    processing: "OCR 辨識中...",
    reselect: "重新選取",
    close: "關閉",
    translate: "翻譯",
    noText: "未辨識到任何文字",
    langToggle: "EN",
  },
  en: {
    title: "Screen Translator",
    subtitle: "Press Ctrl+Shift+T or click the button to start",
    startBtn: "Start Capture",
    hint: "Drag to select area \u00b7 Esc to cancel",
    processing: "Recognizing...",
    reselect: "Reselect",
    close: "Close",
    translate: "Translate",
    noText: "No text recognized",
    langToggle: "\u4e2d",
  },
} as const;

interface Rect { x: number; y: number; width: number; height: number; }

interface OcrLine { text: string; x: number; y: number; width: number; height: number; }

interface TranslationLine {
  original: string;
  translated: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bgColor: string;
  textColor: string;
}

// 從截圖取樣 bounding box 邊框的平均背景色
function sampleBgColor(img: HTMLImageElement, x: number, y: number, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#ffffff";
  ctx.drawImage(img, 0, 0);

  const border = Math.max(3, Math.round(Math.min(w, h) * 0.12));
  const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
  const W = img.naturalWidth, H = img.naturalHeight;

  const regions = [
    [clamp(x, W), clamp(y, H), clamp(w, W - x), border],
    [clamp(x, W), clamp(y + h - border, H), clamp(w, W - x), border],
    [clamp(x, W), clamp(y, H), border, clamp(h, H - y)],
    [clamp(x + w - border, W), clamp(y, H), border, clamp(h, H - y)],
  ] as [number, number, number, number][];

  let r = 0, g = 0, b = 0, count = 0;
  for (const [sx, sy, sw, sh] of regions) {
    if (sw <= 0 || sh <= 0) continue;
    const d = ctx.getImageData(sx, sy, sw, sh).data;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2]; count++;
    }
  }
  if (count === 0) return "#ffffff";
  return `rgb(${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)})`;
}

// 根據背景亮度選擇黑或白文字
function contrastColor(bg: string): string {
  const m = bg.match(/\d+/g);
  if (!m || m.length < 3) return "#000000";
  const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
  return lum > 0.5 ? "#000000" : "#ffffff";
}

function cropImage(src: string, rect: Rect): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("No canvas context")); return; }
      ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = src;
  });
}

function App() {
  const [mode, setMode] = useState<AppMode>("idle");
  const [lang, setLang] = useState<Lang>("zh");
  const [transDir, setTransDir] = useState<TransDir>("zh-en");
  const t = LOCALE[lang];
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [translations, setTranslations] = useState<TranslationLine[]>([]);
  const [resultSelection, setResultSelection] = useState<Rect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(loadSettings);

  const modeRef = useRef<AppMode>("idle");
  const isDragging = useRef(false);
  const startPos = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const resetToIdle = useCallback(async () => {
    await invoke("close_overlay").catch(console.error);
    setMode("idle");
    setScreenshot(null);
    setSelection(null);
    setTranslations([]);
    setResultSelection(null);
    setError(null);
  }, []);

  const handleToggle = useCallback(async () => {
    if (modeRef.current !== "idle") { resetToIdle(); return; }
    setError(null);
    try {
      const img = await invoke<string>("start_capture");
      setScreenshot(img);
      setSelection(null);
      setMode("selecting");
    } catch (err) {
      console.error("截圖失敗:", err);
    }
  }, [resetToIdle]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    listen("toggle-capture", handleToggle).then((fn) => { cleanup = fn; });
    return () => cleanup?.();
  }, [handleToggle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modeRef.current !== "idle") resetToIdle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetToIdle]);

  const handleTranslate = useCallback(async (overrideSel?: Rect) => {
    const activeSelection = overrideSel ?? selection;
    if (!screenshot || !activeSelection) return;
    setMode("processing");
    setError(null);
    try {
      // 先載入截圖取得原生尺寸，計算 HiDPI 縮放比例
      const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = screenshot!;
      });
      // 原生像素 / CSS 像素（HiDPI 時可能是 1.25、1.5、2.0 等）
      const scaleX = imgEl.naturalWidth / window.innerWidth;
      const scaleY = imgEl.naturalHeight / window.innerHeight;

      // LLM 視覺不需要 padding，嚴格裁切選取範圍，避免翻譯到範圍外的文字
      // Windows OCR 需要 padding 提升辨識率；裁切用原生像素座標
      const PAD = 20;
      const cssX = Math.max(0, activeSelection.x - PAD);
      const cssY = Math.max(0, activeSelection.y - PAD);
      const cssW = Math.min(window.innerWidth - cssX, activeSelection.width + PAD * 2);
      const cssH = Math.min(window.innerHeight - cssY, activeSelection.height + PAD * 2);
      const nativeRect: Rect = {
        x: Math.round(cssX * scaleX),
        y: Math.round(cssY * scaleY),
        width: Math.round(cssW * scaleX),
        height: Math.round(cssH * scaleY),
      };
      const cropped = await cropImage(screenshot, nativeRect);

      // Step 1：Windows OCR 取得每行文字與精確座標
      const ocrLang = transDir === "zh-en" ? "zh-Hant" : "en";
      const targetLang = transDir === "zh-en" ? "en" : "zh";
      const ocrLines = await invoke<OcrLine[]>("ocr_image", { imageBase64: cropped, ocrLang });
      if (ocrLines.length === 0) {
        setError(t.noText);
        setMode("selecting");
        return;
      }

      // Step 2：LLM 翻譯（品質比 Windows OCR 自帶翻譯好）
      const texts = ocrLines.map(l => l.text);
      const translated = await invoke<string[]>("translate_lines", {
        texts,
        targetLang,
        apiUrl: settings.apiUrl,
        model: settings.model,
      });

      // Step 3：座標換算（OCR 回傳的是相對於 nativeRect 的原生像素）
      //         換算回 CSS pixels，並 clamp 到原始選取範圍
      const result: TranslationLine[] = ocrLines.map((line, i) => {
        const fx = cssX + line.x / scaleX;
        const fy = cssY + line.y / scaleY;
        const fw = line.width / scaleX;
        const fh = line.height / scaleY;

        // 跳過中心點不在選取範圍內的行（padding 帶進來的雜訊）
        const centerX = fx + fw / 2;
        const centerY = fy + fh / 2;
        if (
          centerX < activeSelection.x || centerX > activeSelection.x + activeSelection.width ||
          centerY < activeSelection.y || centerY > activeSelection.y + activeSelection.height
        ) return null;

        // 跳過 LLM 沒有翻譯到的行（行數不對齊時）
        if (!translated[i]?.trim()) return null;

        // 保留原始 OCR x/width，譲表格不同欄不會隱响對方內容
        const boxX = Math.max(activeSelection.x, fx);
        const boxW = Math.min(activeSelection.x + activeSelection.width, fx + fw) - boxX;
        if (boxW <= 2) return null;

        const bgColor = sampleBgColor(
          imgEl,
          boxX * scaleX, fy * scaleY,
          boxW * scaleX, Math.max(1, fh * scaleY),
        );
        return {
          original: line.text,
          translated: translated[i],
          x: boxX,
          y: fy,
          width: boxW,
          height: fh,
          bgColor,
          textColor: contrastColor(bgColor),
        };
      }).filter((t): t is TranslationLine => t !== null);

      // 按 (y, x) 排序，然後將每個框的寬度延伸到同一行下一個框的左邊
      // 避免短中文字（架構/訓練目標）的翻譯框太窄導致英文換行亂碼
      result.sort((a, b) => Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y);
      const ROW_THRESHOLD = 24; // 同一行的 y 差距容忍值（px）
      for (let i = 0; i < result.length; i++) {
        const selRight = activeSelection.x + activeSelection.width;
        let rightBound = selRight;
        for (let j = i + 1; j < result.length; j++) {
          if (Math.abs(result[j].y - result[i].y) <= ROW_THRESHOLD && result[j].x > result[i].x) {
            rightBound = Math.min(result[j].x - 2, selRight);
            break;
          }
        }
        result[i].width = Math.max(result[i].width, rightBound - result[i].x);
      }

      setTranslations(result);
      setResultSelection(activeSelection);
      setMode("result");
    } catch (err) {
      setError(String(err));
      setMode("selecting");
    }
  }, [screenshot, selection, transDir, lang]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (modeRef.current !== "selecting") return;
    isDragging.current = true;
    startPos.current = { x: e.clientX, y: e.clientY };
    setSelection({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current || !startPos.current) return;
    const x = Math.min(e.clientX, startPos.current.x);
    const y = Math.min(e.clientY, startPos.current.y);
    setSelection({ x, y, width: Math.abs(e.clientX - startPos.current.x), height: Math.abs(e.clientY - startPos.current.y) });
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!isDragging.current || !startPos.current) return;
    isDragging.current = false;
    const x = Math.min(e.clientX, startPos.current.x);
    const y = Math.min(e.clientY, startPos.current.y);
    const w = Math.abs(e.clientX - startPos.current.x);
    const h = Math.abs(e.clientY - startPos.current.y);
    if (w > 10 && h > 10) {
      handleTranslate({ x, y, width: w, height: h });
    }
  };

  if (mode === "idle") {
    return (
      <main className="idle-ui">
        <button className="lang-toggle" onClick={() => setLang(l => l === "zh" ? "en" : "zh")}>{t.langToggle}</button>
        <button className="settings-btn" onClick={() => { setDraftSettings({ ...settings }); setShowSettings(true); }}>⚙</button>
        <h2>{t.title}</h2>
        <p>{t.subtitle}</p>
        <div className="dir-switch">
          <button
            className={transDir === "zh-en" ? "dir-btn active" : "dir-btn"}
            onClick={() => setTransDir("zh-en")}>
            {DIR_LABEL["zh-en"]}
          </button>
          <button
            className={transDir === "en-zh" ? "dir-btn active" : "dir-btn"}
            onClick={() => setTransDir("en-zh")}>
            {DIR_LABEL["en-zh"]}
          </button>
        </div>
        <button onClick={handleToggle}>{t.startBtn}</button>

        {showSettings && (
          <div className="settings-overlay" onClick={() => setShowSettings(false)}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
              <h3>設定 / Settings</h3>
              <label>
                API URL
                <input
                  type="text"
                  value={draftSettings.apiUrl}
                  onChange={e => setDraftSettings(s => ({ ...s, apiUrl: e.target.value }))}
                  placeholder="http://192.168.x.x:8001"
                  spellCheck={false}
                />
              </label>
              <label>
                Model
                <input
                  type="text"
                  value={draftSettings.model}
                  onChange={e => setDraftSettings(s => ({ ...s, model: e.target.value }))}
                  placeholder="gemma-4:31B"
                  spellCheck={false}
                />
              </label>
              <div className="settings-actions">
                <button className="btn-secondary" onClick={() => setShowSettings(false)}>取消</button>
                <button className="btn-primary" onClick={() => {
                  saveSettings(draftSettings);
                  setSettings(draftSettings);
                  setShowSettings(false);
                }}>儲存</button>
              </div>
            </div>
          </div>
        )}
      </main>
    );
  }

  return (
    <div className="overlay" onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp}>
      {screenshot && (
        <img src={screenshot} className="screenshot-bg" alt="screenshot" draggable={false} />
      )}

      {selection && selection.width > 0 && mode !== "result" && (
        <div className="selection-rect" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />
      )}

      {mode === "result" && translations.length > 0 && resultSelection && (
        // clipping container：嚴格限制在選取範圍，overflow hidden
        <div style={{
          position: "absolute",
          left: resultSelection.x,
          top: resultSelection.y,
          width: resultSelection.width,
          height: resultSelection.height,
          overflow: "hidden",
          pointerEvents: "none",
        }}>
          {translations.map((t, i) => {
            return (
              <div key={i} className="translation-box" title={t.translated} style={{
                left: t.x - resultSelection.x,
                top: t.y - resultSelection.y,
                width: t.width,
                minHeight: t.height,
                background: t.bgColor,
                color: t.textColor,
              }}>
                {t.translated}
              </div>
            );
          })}
        </div>
      )}

      {mode === "selecting" && <div className="hint">{t.hint}</div>}

      {mode === "processing" && (
        <div className="processing-overlay">
          <div className="spinner" />
          <span>{t.processing}</span>
        </div>
      )}

      {error && <div className="error-toast">{error}</div>}

      {(mode === "selected" || mode === "result") && (
        <div className="action-bar">
          {mode === "selected" && selection && (
            <span className="size-label">{Math.round(selection.width)} × {Math.round(selection.height)} px</span>
          )}
          {mode === "selected" && (
            <>
              <button className="btn-secondary" onClick={() => setMode("selecting")}>{t.reselect}</button>
              <button className="btn-primary" onClick={() => handleTranslate()}>{t.translate}</button>
            </>
          )}
          {mode === "result" && (
            <button className="btn-secondary" onClick={() => { setTranslations([]); setSelection(null); setMode("selecting"); }}>{t.reselect}</button>
          )}
          <button className="btn-danger" onClick={resetToIdle}>{t.close}</button>
        </div>
      )}
    </div>
  );
}

export default App;
