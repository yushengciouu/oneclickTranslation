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
    fullScreenBtn: "一鍵全頁翻譯",
    hint: "拖曳選取範圍 · 按空白鍵全頁翻譯 · Esc 取消",
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
    fullScreenBtn: "Full Page Translate",
    hint: "Drag to select \u00b7 Space for full page \u00b7 Esc to cancel",
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

  // 定義邊框寬度，不宜太大以免踩到文字本身
  const border = Math.max(1, Math.round(Math.min(w, h) * 0.08));
  const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.round(v), max));
  const W = img.naturalWidth, H = img.naturalHeight;

  // 取得四個邊緣的取樣區域
  const regions = [
    [clamp(x + border, W), clamp(y, H), clamp(w - 2 * border, W - (x + border)), border], // 頂部（微縮，避開角隅）
    [clamp(x + border, W), clamp(y + h - border, H), clamp(w - 2 * border, W - (x + border)), border], // 底部（微縮，避開角隅）
    [clamp(x, W), clamp(y + border, H), border, clamp(h - 2 * border, H - (y + border))], // 左側（微縮，避開角隅）
    [clamp(x + w - border, W), clamp(y + border, H), border, clamp(h - 2 * border, H - (y + border))], // 右側（微縮，避開角隅）
  ] as [number, number, number, number][];

  // 1. 收集所有取樣區域的 R, G, B 與對應的亮度 (Luminance)
  const colors: { r: number; g: number; b: number; lum: number }[] = [];
  
  for (const [sx, sy, sw, sh] of regions) {
    if (sw <= 0 || sh <= 0) continue;
    const d = ctx.getImageData(sx, sy, sw, sh).data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      // 標準相對亮度公式
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colors.push({ r, g, b, lum });
    }
  }

  if (colors.length === 0) return "#ffffff";

  // 2. 排序並過濾掉極端值（中位數濾波）：排除掉可能碰到底層文字、外框線等高/低亮度雜訊
  colors.sort((a, b) => a.lum - b.lum);

  // 捨棄最低 25% 與最高 25% 的極端像素，只取中間 50% 像素
  const startIndex = Math.floor(colors.length * 0.25);
  const endIndex = Math.ceil(colors.length * 0.75);
  const validColors = colors.slice(startIndex, endIndex);

  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (const c of validColors) {
    rSum += c.r;
    gSum += c.g;
    bSum += c.b;
    count++;
  }

  if (count === 0) return "#ffffff";
  return `rgb(${Math.round(rSum / count)},${Math.round(gSum / count)},${Math.round(bSum / count)})`;
}

// 根據文字長度、寬度、高度，以及目前翻譯目標語言 (中文或英文)，動態計算最適合、最清晰舒適的字型大小
function getAutoFontSize(text: string, width: number, height: number, targetLang: string): string {
  if (!text) return "11px";
  
  let zhChars = 0;
  let enChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      zhChars++;
    } else {
      enChars++;
    }
  }

  const isZh = targetLang === "zh";

  if (isZh) {
    // 英文翻中文 (en-zh)：
    // 中文字體複雜度高、筆劃較多，需要至少 11px 才清晰。由於中文翻譯長度多半比英文原文短，
    // 容器寬度非常充裕，因此主動調大基準字體（調至 12.5px ~ 14.5px 視高度決定），能提供極高質量的精緻閱讀感。
    const baseSize = Math.max(12, Math.min(14.5, height - 2.5));
    const singleCharWidth = 0.98; // 中文接近 1:1 的正方形寬度
    const asciiCharWidth = 0.55;  // 半形字元寬度
    const expectedWidth = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize;

    if (expectedWidth > width) {
      if (height < 25) {
        // 單行模式：盡可能縮小以容納，但中文下限設為 11px 避免糊成一團
        const fitSize = width / (zhChars * singleCharWidth + enChars * asciiCharWidth);
        return `${Math.max(11, Math.min(baseSize, fitSize)).toFixed(1)}px`;
      } else {
        // 多行模式
        const area = width * height;
        const requiredArea = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize * (baseSize * 1.35);
        if (requiredArea > area) {
          const ratio = Math.sqrt(area / requiredArea);
          return `${Math.max(11, Math.min(baseSize, baseSize * ratio)).toFixed(1)}px`;
        }
      }
    }
    return `${baseSize.toFixed(1)}px`;
  } else {
    // 中文翻英文 (zh-en)：
    // 英文可讀性高，邊框尺寸即使低到 9.5px 依然清晰可辨。但英文翻譯長度較長，
    // 有容易擠壓和重疊的傾向，故基準字體設定在較小的 11px 程度。
    const baseSize = Math.max(10.5, Math.min(11.5, height - 3));
    const singleCharWidth = 0.95;
    const asciiCharWidth = 0.55;
    const expectedWidth = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize;

    if (expectedWidth > width) {
      if (height < 25) {
        // 單行模式：英文單形小寫下限設為 9.5px 依然易讀
        const fitSize = width / (zhChars * singleCharWidth + enChars * asciiCharWidth);
        return `${Math.max(9.5, Math.min(baseSize, fitSize)).toFixed(1)}px`;
      } else {
        // 多行模式
        const area = width * height;
        const requiredArea = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize * (baseSize * 1.25);
        if (requiredArea > area) {
          const ratio = Math.sqrt(area / requiredArea);
          return `${Math.max(9.5, Math.min(baseSize, baseSize * ratio)).toFixed(1)}px`;
        }
      }
    }
    return `${baseSize.toFixed(1)}px`;
  }
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

  const handleToggle = useCallback(async (event?: any) => {
    if (modeRef.current !== "idle") { resetToIdle(); return; }
    setError(null);
    try {
      let img = event?.payload as string | undefined | null;
      if (!img) {
        img = await invoke<string>("start_capture");
      }
      setScreenshot(img);
      setSelection(null);
      setMode("selecting");
    } catch (err) {
      console.error("截圖失敗:", err);
    }
  }, [resetToIdle]);

  const handleTranslate = useCallback(async (overrideSel?: Rect, overrideScreenshot?: string) => {
    const activeSelection = overrideSel ?? selection;
    const activeScreenshot = overrideScreenshot ?? screenshot;
    if (!activeScreenshot || !activeSelection) return;
    setMode("processing");
    setError(null);
    try {
      // 先載入截圖取得原生尺寸，計算 HiDPI 縮放比例
      const imgEl = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = activeScreenshot;
      });
      // 原生像素 / CSS 像素（HiDPI 時可能是 1.25、1.5、2.0 等）
      const scaleX = imgEl.naturalWidth / window.innerWidth;
      const scaleY = imgEl.naturalHeight / window.innerHeight;

      // 絕不使用會隨邊界裁截而導致座標平移失真（防偏移痛點）的額外 Padding。
      // 當選取框貼近螢幕 0,0 邊界時，防 Padding 的裁切位置會發生非線性偏移。
      // 這裡直接對齊 activeSelection 進行嚴格裁切，徹底根除偏位問題。
      const nativeRect: Rect = {
        x: Math.round(activeSelection.x * scaleX),
        y: Math.round(activeSelection.y * scaleY),
        width: Math.round(activeSelection.width * scaleX),
        height: Math.round(activeSelection.height * scaleY),
      };
      const cropped = await cropImage(activeScreenshot, nativeRect);

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

      // Step 3：座標換算（OCR 回傳的是相對於 cropped 裁切圖片的原生像素）
      //         因為裁切使用了絕對對齊的 activeSelection（無 Pad 偏移），
      //         所以換算回全螢幕 CSS pixels 時，直接百分之百等比對齊！
      const result: TranslationLine[] = ocrLines.map((line, i) => {
        const fx = activeSelection.x + line.x / scaleX;
        const fy = activeSelection.y + line.y / scaleY;
        const fw = line.width / scaleX;
        const fh = line.height / scaleY;

        // 跳過中心點不在選取範圍內的行（安全過濾）
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

  const handleFullScreenTranslate = useCallback(async () => {
    setError(null);
    try {
      let img = screenshot;
      if (!img) {
        img = await invoke<string>("start_capture");
        setScreenshot(img);
      }
      const fullRect: Rect = {
        x: 0,
        y: 0,
        width: window.innerWidth,
        height: window.innerHeight,
      };
      setSelection(fullRect);
      await handleTranslate(fullRect, img);
    } catch (err) {
      console.error("全頁翻譯失敗:", err);
      setError(String(err));
    }
  }, [screenshot, handleTranslate]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    listen("toggle-capture", handleToggle).then((fn) => { cleanup = fn; });
    return () => cleanup?.();
  }, [handleToggle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modeRef.current !== "idle") {
        resetToIdle();
      } else if (e.key === " " && modeRef.current === "selecting") {
        e.preventDefault();
        handleFullScreenTranslate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetToIdle, handleFullScreenTranslate]);

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
        <div style={{ display: "flex", gap: "12px" }}>
          <button onClick={handleToggle}>{t.startBtn}</button>
          {/* 暫時隱藏一鍵全頁翻譯按鈕，保留底層邏輯與空白捷徑功能
          <button onClick={handleFullScreenTranslate} style={{ backgroundColor: "#2ecc71" }}>{t.fullScreenBtn}</button>
          */}
        </div>

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
            const targetLang = transDir === "zh-en" ? "en" : "zh";
            const dynamicFontSize = getAutoFontSize(t.translated, t.width, t.height, targetLang);
            // 加上上下左右少許 padding/margin 偏移與尺寸膨脹補貼，確保完美蓋住原文
            const paddingOffset = 1.5; 
            return (
              <div key={i} className="translation-box" title={t.translated} style={{
                left: t.x - resultSelection.x - paddingOffset,
                top: t.y - resultSelection.y - paddingOffset,
                width: t.width + paddingOffset * 2,
                minHeight: t.height + paddingOffset * 2, // 既設 minHeight 避免單詞折行蓋不住，又限制高度差
                fontSize: dynamicFontSize,
                background: t.bgColor,
                color: t.textColor,
                // 高度特製化文字與排版設定
                lineHeight: targetLang === "zh" ? 1.35 : 1.25,
                wordBreak: targetLang === "zh" ? "break-all" : "break-word",
                letterSpacing: targetLang === "zh" ? "0.02em" : "-0.012em",
                fontWeight: targetLang === "zh" ? 550 : 500,
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
