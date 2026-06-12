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

// 從截圖取樣 bounding box 的主導背景色（排除前景文字雜訊）
function sampleBgColor(img: HTMLImageElement, x: number, y: number, w: number, h: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#ffffff";
  ctx.drawImage(img, 0, 0);

  const W = img.naturalWidth, H = img.naturalHeight;
  const rx = Math.max(0, Math.min(Math.round(x), W - 1));
  const ry = Math.max(0, Math.min(Math.round(y), H - 1));
  const rw = Math.max(1, Math.min(Math.round(w), W - rx));
  const rh = Math.max(1, Math.min(Math.round(h), H - ry));

  try {
    const d = ctx.getImageData(rx, ry, rw, rh).data;
    const colors: { r: number; g: number; b: number; lum: number }[] = [];
    
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const a = d[i + 3];
      if (a < 50) continue; // 忽略透明像素
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colors.push({ r, g, b, lum });
    }

    if (colors.length === 0) return "#ffffff";

    // 使用偏向兩極群組中位數統計：
    // 在有文字的地方，像素中不是背景色（佔大多數）就是文字筆劃顏色（佔少數，且通常是深黑或純白等極端顏色）。
    // 我們先找出亮度的中位數，如果是亮背景（中位數 > 127），背景色會集中在亮端，進一步取 35% ~ 90% 的平均；
    // 如果是暗背景（中位數 <= 127），背景色集中在暗端，進一步取 10% ~ 65% 的平均。
    // 這能達到近乎完美地排乾除文字筆劃（反差極端色）雜訊，還原最真實的背景純色！
    colors.sort((a, b) => a.lum - b.lum);
    const medianLum = colors[Math.floor(colors.length / 2)].lum;
    
    let validSrc;
    if (medianLum > 127) {
      // 亮色背景：拋棄最暗的 35%（通常是黑色字體筆劃及其抗鋸齒邊緣）
      const start = Math.floor(colors.length * 0.35);
      const end = Math.floor(colors.length * 0.95);
      validSrc = colors.slice(start, end);
    } else {
      // 暗色背景：拋棄最亮的 35%（通常是白色字體筆劃其暈開邊緣）
      const start = Math.floor(colors.length * 0.05);
      const end = Math.floor(colors.length * 0.65);
      validSrc = colors.slice(start, end);
    }

    if (validSrc.length === 0) validSrc = colors;

    let rSum = 0, gSum = 0, bSum = 0;
    for (const c of validSrc) {
      rSum += c.r;
      gSum += c.g;
      bSum += c.b;
    }
    const count = validSrc.length;
    return `rgb(${Math.round(rSum / count)},${Math.round(gSum / count)},${Math.round(bSum / count)})`;
  } catch (e) {
    console.error("取樣背景色失敗:", e);
    return "#ffffff";
  }
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
    // 為了保證大小層次分明（文章標題大、內文小），不應使用窄小的範圍硬性截斷。
    // 我們將基準字體與原始框高（height）直接成等比比例縮放（height * 0.72），最低 11.5px。
    const baseSize = Math.max(11.5, height * 0.72);
    const singleCharWidth = 0.98; // 中文接近 1:1 的正方形寬度
    const asciiCharWidth = 0.55;  // 半形字元寬度
    const expectedWidth = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize;

    if (expectedWidth > width) {
      // 動態判定：如果容器高度小於字體大小的 1.6 倍，說明空間只夠放單行文字
      if (height < baseSize * 1.6) {
        // 單行模式：盡可能縮小以容納，建置最低下限為 11px 以免字體太小模糊不清
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
    // 英文可讀性高，縮小至 9.5px 依然易讀。同樣採用等比縮放（height * 0.68），最低 10px。
    const baseSize = Math.max(10, height * 0.68);
    const singleCharWidth = 0.95;
    const asciiCharWidth = 0.55;
    const expectedWidth = (zhChars * singleCharWidth + enChars * asciiCharWidth) * baseSize;

    if (expectedWidth > width) {
      if (height < baseSize * 1.6) {
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

        // 保留原始 OCR x/width，讓表格不同欄不會影響對方內容
        const boxX = Math.max(activeSelection.x, fx);
        let boxW = Math.min(activeSelection.x + activeSelection.width, fx + fw) - boxX;
        if (boxW <= 2) return null;

        // 【高畫質安全寬度適配】：
        if (targetLang === "en") {
          // 中翻英：英文單字與字元長度通常比中文原文膨脹 1.3 ~ 1.6 倍。
          // 為了提供英文單字折行及長片語呼吸空間，適度微調增加 20% ~ 35% 寬度（限制最高增加 40px），
          // 這既給予英文完美的渲染緩衝，又絕對不會像以前一樣無底線拉長到螢幕邊緣破壞整片圖表！
          const expansion = Math.min(40, boxW * 0.3);
          boxW = Math.min(activeSelection.x + activeSelection.width - boxX, boxW + expansion);
        } else {
          // 英翻中 (targetLang === "zh")：
          // 當原文是側邊欄、設定列表這類「極短單字/列表項」（例如 Emails、Models、Features、Pages），
          // 翻譯後的中文長度可能與英文相當甚至稍長，但原 OCR 偵測邊框「極窄」且「沒有緩衝邊緣」，
          // 這會導致翻譯後的中文因為寬度被壓得太死，被迫發生「極其醜陋的單字卡線強制斷行」（例如：電 子 郵 件 變成上下垂直三行、儲 存 庫 變成兩行）。
          // 解決方案：當偵測到偵測框寬度 w 較窄時，主動給予中文一個「最寬防折行補貼」（額外寬度：16px ~ 35px），
          // 這既能保證短清單項目絕對能在單行內優雅舒展不折行，又不會拉長到破壞地圖或排版！
          const paddingBonus = Math.max(16, Math.min(35, boxW * 0.4));
          boxW = Math.min(activeSelection.x + activeSelection.width - boxX, boxW + paddingBonus);
        }

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
